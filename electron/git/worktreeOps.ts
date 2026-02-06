// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { execGitAsync, isGitExecutableUnavailable, spawnGitAsync } from "./exec";
import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { parseWorktreeListPorcelain } from "./worktreeList";
import { resolveRepoMainPathFromWorktreeAsync, resolveWorktreeBranchNameAsync } from "./worktreeMetaResolve";
import { buildRestoreCommandsForWorktreeStateSnapshot, cleanupWorktreeStateSnapshotAsync, createWorktreeStateSnapshotAsync, restoreWorktreeStateSnapshotAsync, type WorktreeStateSnapshot } from "./worktreeStateSnapshot";
import { buildNextWorktreeMeta, deleteWorktreeMeta, getWorktreeMeta, setWorktreeMeta, type WorktreeMeta } from "../stores/worktreeMetaStore";

export type GitWorktreeBranchInfo = {
  ok: boolean;
  repoRoot?: string;
  branches?: string[];
  current?: string;
  detached?: boolean;
  headSha?: string;
  error?: string;
};

export type CreateWorktreesRequest = {
  repoDir: string;
  baseBranch: string;
  instances: Array<{ providerId: "codex" | "claude" | "gemini"; count: number }>;
  gitPath?: string;
  copyRules?: boolean;
  /** 中文说明：创建过程日志回调（用于渲染层进度 UI 展示）。 */
  onLog?: (text: string) => void;
  /** 中文说明：可选取消信号；触发后将尽快停止创建并返回 aborted。 */
  signal?: AbortSignal;
  /** 中文说明：每成功创建一个 worktree 后回调（用于任务取消时的回滚清理）。 */
  onItemCreated?: (item: CreatedWorktree) => void;
  /** 中文说明：单个 worktree 创建失败时回调（用于 UI 逐项标记失败）。 */
  onItemFailed?: (args: {
    providerId: "codex" | "claude" | "gemini";
    repoMainPath: string;
    worktreePath: string;
    baseBranch: string;
    wtBranch: string;
    index: number;
    error: string;
  }) => void;
  /** 中文说明：在尝试创建某个 worktree 前回调（用于捕获“中断时的目标目录/分支”）。 */
  onWorktreePlanned?: (args: { providerId: "codex" | "claude" | "gemini"; repoMainPath: string; worktreePath: string; baseBranch: string; wtBranch: string; index: number }) => void;
};

export type CreatedWorktree = {
  providerId: "codex" | "claude" | "gemini";
  repoMainPath: string;
  worktreePath: string;
  baseBranch: string;
  wtBranch: string;
  /** 目录编号（<项目名>_wt<n> 的 n） */
  index: number;
  /** 复制规则文件时的非致命警告 */
  warnings?: string[];
};

export type AutoCommitResult = {
  ok: boolean;
  committed: boolean;
  error?: string;
};

export type RecycleMode = "squash" | "rebase";

export type RecycleWorktreeRequest = {
  worktreePath: string;
  baseBranch: string;
  wtBranch: string;
  /** 回收范围：默认仅回收分叉点之后的提交；可选完整回收。 */
  range?: "since_fork" | "full";
  /** 可选：手动指定的分叉点引用（提交号/引用），仅在 range=since_fork 时生效。 */
  forkBaseRef?: string;
  mode: RecycleMode;
  gitPath?: string;
  commitMessage?: string;
  /**
   * 中文说明：当主 worktree 不干净时，是否允许自动暂存并在回收后恢复。
   * - true：使用“事务化快照”策略，最大化保持主 worktree 原本的三态不被打乱：
   *   - 1) Working Tree：用单个 `git stash push -u` 保存内容级快照（tracked + untracked）
   *   - 2) Index：对 `.git/index` 做字节级快照（这是 staged 语义的权威来源）
   *   - 3) 回收完成后：先将工作区清空到确定态，再“只覆盖、不合并”回放工作区快照，最后原样覆盖恢复 index，并做指纹校验
   * - false/未传：直接返回 BASE_WORKTREE_DIRTY，由 UI 决定下一步。
   */
  autoStashBaseWorktree?: boolean;
  /** 中文说明：回收过程日志回调（用于渲染层进度 UI 展示）。 */
  onLog?: (text: string) => void;
};

export type RecycleWorktreeErrorCode =
  | "INVALID_ARGS"
  | "META_MISSING"
  | "FORK_POINT_UNAVAILABLE"
  | "FORK_POINT_INVALID"
  | "BASE_WORKTREE_DIRTY"
  | "WORKTREE_DIRTY"
  | "BASE_WORKTREE_IN_PROGRESS"
  | "BASE_WORKTREE_LOCKED"
  | "BASE_WORKTREE_STASH_FAILED"
  | "BASE_WORKTREE_DIRTY_AFTER_STASH"
  | "RECYCLE_FAILED"
  | "UNKNOWN";

export type RecycleWorktreeWarningCode =
  | "BASE_WORKTREE_RESTORE_CONFLICT"
  | "BASE_WORKTREE_RESTORE_FAILED"
  | "BASE_WORKTREE_STASH_DROP_FAILED";

export type RecycleBaseWorktreeStashKind = "staged" | "unstaged";

export type RecycleBaseWorktreeStash = {
  kind: RecycleBaseWorktreeStashKind;
  sha: string;
  message: string;
};

export type RecycleWorktreeDetails = {
  /** 主 worktree 路径（用于 UI 提供“外部工具打开”入口）。 */
  repoMainPath?: string;
  /** 回收操作涉及的基/源分支（用于 UI 展示/诊断）。 */
  baseBranch?: string;
  wtBranch?: string;
  /** 原始位置（用于回收后恢复到正确分支/提交）。 */
  originalRef?: { kind: "branch"; name: string } | { kind: "detached"; sha: string };
  /** 若已创建 stash，则返回稳定引用与可追溯标记（可能包含多个：已暂存/未暂存）。 */
  stashes?: RecycleBaseWorktreeStash[];
  /** 建议的手动恢复命令（用于失败兜底引导）。 */
  suggestedRestoreCommand?: string;
  /** 中文说明：未知错误兜底展示用的原始输出（避免后端拼英文）。 */
  stderr?: string;
  stdout?: string;
  error?: string;
};

export type RecycleWorktreeResult =
  | { ok: true; warningCode?: RecycleWorktreeWarningCode; details?: RecycleWorktreeDetails }
  | { ok: false; errorCode: RecycleWorktreeErrorCode; details?: RecycleWorktreeDetails };

export type RemoveWorktreeRequest = {
  worktreePath: string;
  gitPath?: string;
  /** 是否同时删除对应的 worktree 分支 */
  deleteBranch?: boolean;
  /** 当分支未合并时是否强制删除 */
  forceDeleteBranch?: boolean;
  /** 当 worktree 不干净时是否强制移除（可能造成未提交修改丢失） */
  forceRemoveWorktree?: boolean;
};

export type RemoveWorktreeResult = {
  ok: boolean;
  removedWorktree: boolean;
  removedBranch: boolean;
  /** 未合并分支需要强确认 */
  needsForceDeleteBranch?: boolean;
  /** worktree 不干净需要强确认 */
  needsForceRemoveWorktree?: boolean;
  error?: string;
};

/**
 * 中文说明：删除 worktree 的并发锁（按 worktreePath 归一化 key 去重）。
 * - 目的：避免用户重复点击触发多个并发的 `git worktree remove`，导致锁冲突/未知状态。
 * - 行为：同一路径的重复调用会复用同一个 Promise，并返回相同结果。
 */
const removeWorktreeTaskByPathKey = new Map<string, Promise<RemoveWorktreeResult>>();

/**
 * 中文说明：仓库维度互斥锁（按 repoMainPath 归一化 key 串行化）。
 * - 目的：避免并发 stash/checkout/merge 导致状态漂移或互相踩 `index.lock`。
 */
const repoTaskByRepoKey = new Map<string, Promise<void>>();

/**
 * 中文说明：在同一仓库维度串行执行任务（互斥）。
 * - 说明：同一 repoKey 的任务会按提交顺序排队执行；无论成功/失败都会释放锁。
 */
async function runExclusiveInRepoAsync<T>(repoKey: string, task: () => Promise<T>): Promise<T> {
  const key = String(repoKey || "").trim();
  if (!key) return await task();
  const prev = repoTaskByRepoKey.get(key) || Promise.resolve();
  const current = prev.catch(() => {}).then(task);
  const currentSettled = current.then(() => {}, () => {});
  repoTaskByRepoKey.set(key, currentSettled);
  try {
    return await current;
  } finally {
    if (repoTaskByRepoKey.get(key) === currentSettled) repoTaskByRepoKey.delete(key);
  }
}

/**
 * 中文说明：best-effort 删除 worktree 目录（避免 `git worktree remove` 在文件占用/权限问题下残留目录）。
 * - 仅作为兜底：失败不抛错。
 */
async function removeWorktreeDirBestEffortAsync(worktreePath: string): Promise<void> {
  const wt = toFsPathAbs(worktreePath);
  if (!wt) return;
  try {
    await fsp.rm(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 } as any);
  } catch {}
}

/**
 * 读取当前仓库的分支信息（用于 baseBranch 下拉）。
 */
export async function listLocalBranchesAsync(args: { repoDir: string; gitPath?: string; timeoutMs?: number }): Promise<GitWorktreeBranchInfo> {
  const repoDirAbs = toFsPathAbs(args.repoDir);
  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 6000)));
  const gitPath = args.gitPath;

  const top = await execGitAsync({ gitPath, argv: ["-C", repoDirAbs, "rev-parse", "--show-toplevel"], timeoutMs });
  if (!top.ok) return { ok: false, error: top.error || top.stderr.trim() || "not a git repo" };
  const repoRoot = String(top.stdout || "").trim();

  const br = await execGitAsync({ gitPath, argv: ["-C", repoRoot, "for-each-ref", "refs/heads", "--format=%(refname:short)"], timeoutMs });
  const branches = br.ok
    ? String(br.stdout || "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  const cur = await execGitAsync({ gitPath, argv: ["-C", repoRoot, "symbolic-ref", "--short", "-q", "HEAD"], timeoutMs });
  const current = String(cur.stdout || "").trim();
  const detached = !(cur.ok && current);
  const headSha = detached
    ? (() => {
        // detached 时给一个短 sha 兜底，便于 UI 提示
        // 注意：失败不影响主流程
        return "";
      })()
    : "";

  const sha = detached ? await execGitAsync({ gitPath, argv: ["-C", repoRoot, "rev-parse", "--short", "HEAD"], timeoutMs }) : null;
  const resolvedSha = sha && sha.ok ? String(sha.stdout || "").trim() : headSha;

  return { ok: true, repoRoot, branches, current: current || undefined, detached, headSha: resolvedSha || undefined };
}

/**
 * 创建多个 worktree：按统一上级目录管理并复用 <项目名>_wt<n> 的最小可用 n。
 */
export async function createWorktreesAsync(req: CreateWorktreesRequest): Promise<{ ok: boolean; items?: CreatedWorktree[]; error?: string }> {
  const repoDirAbs = toFsPathAbs(req.repoDir);
  const gitPath = req.gitPath;
  const timeoutMs = 15_000;
  const listTimeoutMs = 30_000;
  const worktreeAddTimeoutMs = 15 * 60_000;
  const signal = req.signal;
  let abortLogged = false;

  /**
   * 中文说明：安全写日志，避免日志回调抛错影响主流程。
   */
  const log = (text: string) => {
    try { req.onLog?.(String(text ?? "")); } catch {}
  };

  /**
   * 中文说明：检查是否已取消；若已取消则返回一个统一的失败结果。
   */
  const checkAborted = (): { ok: false; error: string } | null => {
    if (!signal?.aborted) return null;
    if (!abortLogged) {
      abortLogged = true;
      log("\n已取消：停止创建\n");
    }
    return { ok: false, error: "aborted" };
  };

  /**
   * 中文说明：将一次 git 执行失败拼成更可读的错误文本（优先 stderr，其次 stdout）。
   */
  const formatGitFailure = (res: { error?: string; stderr?: string; stdout?: string; exitCode?: number }, fallback: string): string => {
    const parts: string[] = [];
    const msg = String(res?.error || "").trim();
    const err = String(res?.stderr || "").trim();
    const out = String(res?.stdout || "").trim();
    if (msg && msg !== "exit 0") parts.push(msg);
    if (err) parts.push(err);
    if (out) parts.push(out);
    const joined = parts.join("\n").trim();
    if (joined) return joined;
    const code = typeof res?.exitCode === "number" && res.exitCode >= 0 ? ` (exit ${res.exitCode})` : "";
    return `${fallback}${code}`;
  };

  // 让进度面板能尽快出现内容
  log(`开始创建 worktree\nrepoDir: ${repoDirAbs}\nbaseBranch: ${String(req.baseBranch || "").trim()}\n\n`);
  const preAbort = checkAborted();
  if (preAbort) return preAbort;

  const top = await execGitAsync({ gitPath, argv: ["-C", repoDirAbs, "rev-parse", "--show-toplevel"], timeoutMs });
  if (!top.ok) {
    const msg = formatGitFailure(top, "not a git repo");
    log(`失败：${msg}\n`);
    return { ok: false, error: msg };
  }
  const repoRoot = String(top.stdout || "").trim();
  const baseBranch = String(req.baseBranch || "").trim();

  /**
   * 中文说明：记录“创建时基分支 HEAD（提交号）”作为后续回收的默认分叉点边界。
   * - 失败不影响创建主流程（回收时会回退到 merge-base 推断）。
   */
  const baseRefAtCreate = await execGitAsync({ gitPath, argv: ["-C", repoRoot, "rev-parse", baseBranch], timeoutMs: 8000 });
  const baseRefAtCreateSha = baseRefAtCreate.ok ? String(baseRefAtCreate.stdout || "").trim() : "";

  const wtListRes = await execGitAsync({ gitPath, argv: ["-C", repoRoot, "worktree", "list", "--porcelain"], timeoutMs: listTimeoutMs });
  if (!wtListRes.ok) {
    const msg = formatGitFailure(wtListRes, "failed to list worktrees");
    log(`失败：${msg}\n`);
    return { ok: false, error: msg };
  }
  const wtList = parseWorktreeListPorcelain(wtListRes.stdout);
  const mainWorktreePath = String(wtList[0]?.worktree || repoRoot).trim() || repoRoot;
  const projectName = path.basename(mainWorktreePath);
  const projectParent = path.dirname(mainWorktreePath);
  const poolDir = path.join(projectParent, `${projectName}_wt`);

  // 统一将 worktree list 路径归一化为 key，便于快速查重
  const registered = new Set<string>(wtList.map((x) => toFsPathKey(x.worktree)).filter(Boolean));

  const total = req.instances.reduce((sum, x) => sum + Math.max(0, Math.floor(Number(x.count) || 0)), 0);
  if (total <= 0) return { ok: false, error: "count must be > 0" };
  if (total > 8) return { ok: false, error: "total instances must be <= 8" };

  try {
    await fsp.mkdir(poolDir, { recursive: true });
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }

  /**
   * 判断目录是否不存在或为空（满足 `git worktree add` 的目标目录要求）。
   */
  const dirAvailable = async (dir: string): Promise<boolean> => {
    try {
      const st = await fsp.stat(dir).catch(() => null as any);
      if (!st) return true;
      if (!st.isDirectory()) return false;
      const items = await fsp.readdir(dir).catch(() => [] as string[]);
      return items.length === 0;
    } catch {
      return false;
    }
  };

  /**
   * 预读取现有 worktree 分支（cf-wt/*），用于后续生成“规则化且不冲突”的分支名。
   */
  const existingWtBranches = new Set<string>();
  try {
    const refs = await execGitAsync({ gitPath, argv: ["-C", repoRoot, "for-each-ref", "refs/heads/cf-wt", "--format=%(refname:short)"], timeoutMs: 8000 });
    if (refs.ok) {
      String(refs.stdout || "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((b) => existingWtBranches.add(b));
    }
  } catch {}

  /**
   * 生成一个“规则化”的 worktree 分支名（不再使用随机串），并在仓库内确认不冲突。
   * 规则：
   * - 基础：cf-wt/<providerId>/wt<n>（n 与目录编号一致）
   * - 若冲突：追加递增后缀：cf-wt/<providerId>/wt<n>-2 / -3 ...
   */
  const makeUniqueWtBranch = (providerId: string, n: number): string => {
    const pid = String(providerId || "").trim().toLowerCase();
    const idx = Math.max(1, Math.floor(Number(n) || 1));
    const base = `cf-wt/${pid}/wt${idx}`;
    if (!existingWtBranches.has(base)) {
      existingWtBranches.add(base);
      return base;
    }
    for (let i = 2; i < 10_000; i++) {
      const candidate = `${base}-${i}`;
      if (!existingWtBranches.has(candidate)) {
        existingWtBranches.add(candidate);
        return candidate;
      }
    }
    // 极端兜底：仍保持“有规律”的命名，避免引入随机串
    const fallback = `${base}-10000`;
    existingWtBranches.add(fallback);
    return fallback;
  };

  /**
   * 在创建 worktree 后按规则复制 AI 规则文件（非致命）。
   */
  const copyRulesIfNeeded = async (targetWorktree: string): Promise<string[]> => {
    const warnings: string[] = [];
    if (req.copyRules !== true) return warnings;
    const names = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
    for (const name of names) {
      try {
        const src = path.join(mainWorktreePath, name);
        if (!fs.existsSync(src)) continue;
        const ign = await execGitAsync({ gitPath, argv: ["-C", mainWorktreePath, "check-ignore", "-q", name], timeoutMs: 4000 });
        // check-ignore：0=ignored，1=not ignored，128=error
        if (ign.exitCode !== 0) continue;
        const dst = path.join(targetWorktree, name);
        await fsp.copyFile(src, dst);
      } catch (e: any) {
        warnings.push(`${name}: ${String(e?.message || e)}`);
      }
    }
    return warnings;
  };

  /**
   * 中文说明：创建计划项（每一项对应一个目标 worktree）。
   */
  type WorktreeCreatePlan = {
    providerId: "codex" | "claude" | "gemini";
    index: number;
    targetDir: string;
    wtBranch: string;
  };

  const plans: WorktreeCreatePlan[] = [];
  for (const inst of req.instances) {
    const providerId = inst.providerId;
    const count = Math.max(0, Math.floor(Number(inst.count) || 0));
    for (let createdIndex = 0; createdIndex < count; createdIndex++) {
      const aborted = checkAborted();
      if (aborted) return aborted;

      let chosenIndex = 0;
      let targetDir = "";
      for (let dirIndex = 1; dirIndex < 10_000; dirIndex++) {
        const abortedInSearch = checkAborted();
        if (abortedInSearch) return abortedInSearch;
        const candidate = path.join(poolDir, `${projectName}_wt${dirIndex}`);
        const available = await dirAvailable(candidate);
        const notRegistered = !registered.has(toFsPathKey(candidate));
        if (available && notRegistered) {
          chosenIndex = dirIndex;
          targetDir = candidate;
          break;
        }
      }
      if (!chosenIndex || !targetDir) return { ok: false, error: "no available worktree slot" };
      registered.add(toFsPathKey(targetDir));
      plans.push({
        providerId,
        index: chosenIndex,
        targetDir,
        wtBranch: makeUniqueWtBranch(providerId, chosenIndex),
      });
    }
  }

  /**
   * 中文说明：判断 `git worktree add` 失败是否属于并发可重试的锁冲突。
   */
  const isRetryableWorktreeAddError = (msg: string): boolean => {
    const text = String(msg || "");
    return (
      /index\.lock/i.test(text) ||
      /cannot lock ref/i.test(text) ||
      /Unable to create '.*\.lock'/i.test(text) ||
      /another git process seems to be running/i.test(text) ||
      /failed to create lock file/i.test(text) ||
      /is locked/i.test(text)
    );
  };

  /**
   * 中文说明：按尝试次数计算重试退避时间（毫秒）。
   */
  const computeRetryDelayMs = (attempt: number): number => {
    const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
    return Math.min(2_000, 160 * Math.pow(2, normalizedAttempt - 1));
  };

  /**
   * 中文说明：异步等待指定毫秒。
   */
  const sleepAsync = async (delayMs: number): Promise<void> => {
    const safeDelay = Math.max(0, Math.floor(Number(delayMs) || 0));
    if (safeDelay <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, safeDelay));
  };

  /**
   * 中文说明：执行单项 `git worktree add`，并在锁冲突时进行有限重试。
   */
  const runWorktreeAddWithRetryAsync = async (plan: WorktreeCreatePlan): Promise<{ ok: boolean; error?: string }> => {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const abortedBeforeRun = checkAborted();
      if (abortedBeforeRun) return abortedBeforeRun;

      log(`\n[${plan.providerId}#${plan.index}] $ git -C "${repoRoot}" worktree add -b "${plan.wtBranch}" "${plan.targetDir}" "${String(req.baseBranch || "").trim()}"\n`);
      const add = await spawnGitAsync({
        gitPath,
        argv: ["-C", repoRoot, "worktree", "add", "-b", plan.wtBranch, plan.targetDir, req.baseBranch],
        timeoutMs: worktreeAddTimeoutMs,
        onStdout: (chunk) => log(`[${plan.providerId}#${plan.index}] ${chunk}`),
        onStderr: (chunk) => log(`[${plan.providerId}#${plan.index}] ${chunk}`),
        signal,
      });
      const abortedAfterRun = checkAborted();
      if (abortedAfterRun) return abortedAfterRun;
      if (add.ok) return { ok: true };

      const failureMessage = formatGitFailure(add, "git worktree add failed");
      if (attempt < maxAttempts && isRetryableWorktreeAddError(failureMessage)) {
        const retryDelay = computeRetryDelayMs(attempt);
        log(`[${plan.providerId}#${plan.index}] 检测到并发锁冲突，${retryDelay}ms 后重试（${attempt}/${maxAttempts}）\n`);
        await sleepAsync(retryDelay);
        continue;
      }
      return { ok: false, error: failureMessage };
    }
    return { ok: false, error: "git worktree add failed after retries" };
  };

  const createdItems: CreatedWorktree[] = [];
  const failures: Array<{ plan: WorktreeCreatePlan; error: string }> = [];
  let planCursor = 0;

  /**
   * 中文说明：从计划队列中提取下一项（无项时返回 null）。
   */
  const takeNextPlan = (): WorktreeCreatePlan | null => {
    if (planCursor >= plans.length) return null;
    const current = plans[planCursor];
    planCursor += 1;
    return current;
  };

  /**
   * 中文说明：执行单个创建计划，并汇总成功项或失败项。
   */
  const executePlanAsync = async (plan: WorktreeCreatePlan): Promise<void> => {
    try {
      req.onWorktreePlanned?.({
        providerId: plan.providerId,
        repoMainPath: mainWorktreePath,
        worktreePath: plan.targetDir,
        baseBranch: req.baseBranch,
        wtBranch: plan.wtBranch,
        index: plan.index,
      });
    } catch {}

    const addResult = await runWorktreeAddWithRetryAsync(plan);
    if (!addResult.ok) {
      const error = String(addResult.error || "git worktree add failed");
      failures.push({ plan, error });
      log(`\n[${plan.providerId}#${plan.index}] 失败：${error}\n`);
      try {
        req.onItemFailed?.({
          providerId: plan.providerId,
          repoMainPath: mainWorktreePath,
          worktreePath: plan.targetDir,
          baseBranch: req.baseBranch,
          wtBranch: plan.wtBranch,
          index: plan.index,
          error,
        });
      } catch {}
      return;
    }

    const warnings = await copyRulesIfNeeded(plan.targetDir);
    const meta: WorktreeMeta = {
      repoMainPath: mainWorktreePath,
      baseBranch: req.baseBranch,
      baseRefAtCreate: baseRefAtCreateSha || undefined,
      wtBranch: plan.wtBranch,
      createdAt: Date.now(),
    };
    setWorktreeMeta(plan.targetDir, meta);

    const item: CreatedWorktree = {
      providerId: plan.providerId,
      repoMainPath: mainWorktreePath,
      worktreePath: plan.targetDir,
      baseBranch: req.baseBranch,
      wtBranch: plan.wtBranch,
      index: plan.index,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
    createdItems.push(item);
    try { req.onItemCreated?.(item); } catch {}
  };

  const maxParallel = Math.max(1, Math.min(4, plans.length));
  const workers = Array.from({ length: maxParallel }, async () => {
    while (true) {
      const aborted = checkAborted();
      if (aborted) return;
      const plan = takeNextPlan();
      if (!plan) return;
      await executePlanAsync(plan);
    }
  });
  await Promise.all(workers);

  const abortedAtEnd = checkAborted();
  if (abortedAtEnd) return abortedAtEnd;

  createdItems.sort((left, right) => {
    const diff = left.index - right.index;
    if (diff !== 0) return diff;
    return String(left.providerId || "").localeCompare(String(right.providerId || ""));
  });

  if (failures.length > 0) {
    const detail = failures.slice(0, 6).map(({ plan, error }) => `[${plan.providerId}#${plan.index}] ${error}`).join("\n");
    const remains = failures.length > 6 ? `\n…以及另外 ${failures.length - 6} 项` : "";
    const summary = `部分 worktree 创建失败（成功 ${createdItems.length}/${plans.length}，失败 ${failures.length}/${plans.length}）\n${detail}${remains}`;
    log(`\n${summary}\n`);
    return { ok: false, error: summary };
  }

  log(`\n完成：已创建 ${createdItems.length}/${plans.length} 个 worktree\n`);
  return { ok: true, items: createdItems };
}

/**
 * 判断指定目录是否为“非主 worktree 的仓库根目录”。
 *
 * 说明：自动提交属于高风险操作，必须避免在主工作区误提交；因此这里不依赖渲染层缓存，而在主进程侧做一次最终判定。
 */
async function isNonMainWorktreeRootAsync(args: { dir: string; gitPath?: string; timeoutMs: number }): Promise<{ ok: boolean; eligible: boolean; error?: string }> {
  const wt = toFsPathAbs(args.dir);
  const gitPath = args.gitPath;
  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 8000)));

  const top = await execGitAsync({ gitPath, argv: ["-C", wt, "rev-parse", "--show-toplevel"], timeoutMs });
  if (!top.ok) {
    const msg = String(top.error || top.stderr || "").trim();
    // 目录不存在/不是仓库：按“不适用”处理，避免打扰用户
    if (/not a git repository|cannot change to|no such file|does not exist|not a directory/i.test(msg)) return { ok: true, eligible: false };
    // git 不可用：自动提交属于后台功能，按“不适用”处理，避免在用户未安装 git 时频繁弹错
    if (isGitExecutableUnavailable(top)) return { ok: true, eligible: false };
    // 其它错误：需要显式暴露，便于用户诊断
    return { ok: false, eligible: false, error: msg || "git rev-parse failed" };
  }
  const repoRoot = String(top.stdout || "").trim();
  if (!repoRoot) return { ok: true, eligible: false };
  if (toFsPathKey(repoRoot) !== toFsPathKey(wt)) return { ok: true, eligible: false }; // 仅 worktree 根目录生效

  // 非主 worktree：其 git-dir 通常位于 <common>/.git/worktrees/<name>
  const gd = await execGitAsync({ gitPath, argv: ["-C", wt, "rev-parse", "--git-dir"], timeoutMs });
  if (!gd.ok) {
    const msg = String(gd.error || gd.stderr || "").trim();
    if (/not a git repository|cannot change to|no such file|does not exist|not a directory/i.test(msg)) return { ok: true, eligible: false };
    if (isGitExecutableUnavailable(gd)) return { ok: true, eligible: false };
    return { ok: false, eligible: false, error: msg || "git rev-parse --git-dir failed" };
  }
  const gitDir = String(gd.stdout || "").trim().replace(/\\/g, "/").toLowerCase();
  const isNonMain = /(^|\/)worktrees\//.test(gitDir);
  return { ok: true, eligible: isNonMain };
}

/**
 * 若 worktree 有变更，则执行 add -A 并提交一次（无变更则不提交）。
 *
 * 规则：仅对“非主 worktree 根目录”生效；其它目录按 no-op 处理（ok=true, committed=false）。
 */
export async function autoCommitWorktreeIfDirtyAsync(args: {
  worktreePath: string;
  gitPath?: string;
  message: string;
  timeoutMs?: number;
}): Promise<AutoCommitResult> {
  const wt = toFsPathAbs(args.worktreePath);
  const gitPath = args.gitPath;
  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 8000)));
  const msg = String(args.message || "").trim();
  if (!msg) return { ok: false, committed: false, error: "missing commit message" };

  const eligible = await isNonMainWorktreeRootAsync({ dir: wt, gitPath, timeoutMs });
  if (!eligible.ok) return { ok: false, committed: false, error: eligible.error || "autoCommit eligibility check failed" };
  if (!eligible.eligible) return { ok: true, committed: false };

  const st = await execGitAsync({ gitPath, argv: ["-C", wt, "status", "--porcelain"], timeoutMs });
  if (st.ok && String(st.stdout || "").trim().length === 0) return { ok: true, committed: false };
  // status 失败也继续尝试提交；由 commit 的错误兜底提示用户

  const add = await execGitAsync({ gitPath, argv: ["-C", wt, "add", "-A"], timeoutMs });
  if (!add.ok) return { ok: false, committed: false, error: add.error || add.stderr.trim() || "git add failed" };

  const commit = await execGitAsync({ gitPath, argv: ["-C", wt, "commit", "-m", msg], timeoutMs });
  if (commit.ok) return { ok: true, committed: true };

  // 兜底：可能出现“无可提交内容”（竞态），不视为错误
  const st2 = await execGitAsync({ gitPath, argv: ["-C", wt, "status", "--porcelain"], timeoutMs });
  if (st2.ok && String(st2.stdout || "").trim().length === 0) return { ok: true, committed: false };

  return { ok: false, committed: false, error: commit.error || commit.stderr.trim() || "git commit failed" };
}

/**
 * 中文说明：判断一次 git 执行失败是否属于“仓库被锁”场景（常见：`.git/index.lock`）。
 */
function isGitLockedFailure(res: { error?: string; stderr?: string; stdout?: string }): boolean {
  const msg = `${String(res?.error || "")}\n${String(res?.stderr || "")}\n${String(res?.stdout || "")}`;
  return /index\.lock|another git process|Unable to create .*\.lock|could not lock|cannot lock|fatal: Unable to create/i.test(msg);
}

/**
 * 中文说明：将 git 失败结果提炼为“尽量可读”的文本（用于 UNKNOWN 错误兜底）。
 */
function pickGitFailureText(res: { error?: string; stderr?: string; stdout?: string }): string {
  const err = String(res?.stderr || "").trim();
  if (err) return err;
  const msg = String(res?.error || "").trim();
  if (msg) return msg;
  return String(res?.stdout || "").trim();
}

/**
 * 中文说明：解析 `git rev-parse --git-path <name>` 为绝对路径。
 */
async function resolveGitPathAbsAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  name: string;
  timeoutMs?: number;
}): Promise<{ ok: true; absPath: string } | { ok: false; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const name = String(args.name || "").trim();
  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 8000)));
  const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "--git-path", name], timeoutMs });
  if (!res.ok) {
    return { ok: false, locked: isGitLockedFailure(res), stderr: String(res.stderr || ""), stdout: String(res.stdout || ""), error: res.error };
  }
  const out = String(res.stdout || "").trim();
  const absPath = path.isAbsolute(out) ? out : path.resolve(repoMainPath, out);
  return { ok: true, absPath };
}

type BaseWorktreeProgressMarkerKind = "merge" | "rebase" | "cherry-pick" | "revert" | "unmerged";

type BaseWorktreeProgressMarker = {
  name: string;
  kind: BaseWorktreeProgressMarkerKind;
  absPath?: string;
};

/**
 * 中文说明：检查指定 Git 标记是否存在，并按需校验目录类型。
 */
async function checkGitProgressMarkerAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  name: string;
  kind: Exclude<BaseWorktreeProgressMarkerKind, "unmerged">;
  isDir?: boolean;
}): Promise<{ ok: true; marker?: BaseWorktreeProgressMarker } | { ok: false; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const p = await resolveGitPathAbsAsync({ repoMainPath: args.repoMainPath, gitPath: args.gitPath, name: args.name, timeoutMs: 8000 });
  if (!p.ok) return p;
  try {
    if (!fs.existsSync(p.absPath)) return { ok: true };
    if (args.isDir) {
      const st = fs.statSync(p.absPath);
      if (!st.isDirectory()) return { ok: true };
    }
    return { ok: true, marker: { name: args.name, kind: args.kind, absPath: p.absPath } };
  } catch {
    return { ok: true };
  }
}

/**
 * 中文说明：为过期标记生成可读、可追溯的归档文件名（保留原始文件名语义）。
 */
function buildStaleMarkerBackupPath(absPath: string): string {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return path.join(dir, `${base}.stale-${stamp}-${process.pid}-${rand}`);
}

/**
 * 中文说明：将疑似“残留中的 Git 标记”改名归档，避免直接删除导致不可追溯。
 */
async function archiveStaleGitMarkerAsync(absPath: string): Promise<{ ok: true; backupPath?: string } | { ok: false; error: string }> {
  const src = String(absPath || "").trim();
  if (!src) return { ok: false, error: "缺少标记文件路径" };
  const backupPath = buildStaleMarkerBackupPath(src);
  try {
    await fsp.rename(src, backupPath);
    return { ok: true, backupPath };
  } catch (e: any) {
    if (String(e?.code || "").toUpperCase() === "ENOENT") return { ok: true };
    return { ok: false, error: String(e?.message || e || "归档残留标记失败") };
  }
}

/**
 * 中文说明：将标记数组格式化为紧凑日志文本（便于进度窗口直观排障）。
 */
function formatProgressMarkers(markers: BaseWorktreeProgressMarker[]): string {
  return markers.map((item) => item.name).filter(Boolean).join(", ");
}

/**
 * 中文说明：检测主 worktree 是否处于“中断/冲突态”，用于拒绝自动化流程（stash/回收/恢复）。
 * - 强阻断：merge/rebase/cherry-pick/revert 进行中，以及存在 unmerged files。
 * - 软修复：仅发现 REBASE_HEAD（且无真实 rebase 目录/冲突）时，自动归档后继续。
 */
async function detectBaseWorktreeInProgressAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  autoRepairStaleMarkers?: boolean;
}): Promise<
  | {
      ok: true;
      inProgress: boolean;
      activeMarkers?: BaseWorktreeProgressMarker[];
      repairedStaleMarkers?: Array<{ name: string; backupPath: string }>;
      repairError?: string;
    }
  | { ok: false; locked: boolean; stderr: string; stdout: string; error?: string }
> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const autoRepairStaleMarkers = args.autoRepairStaleMarkers !== false;
  const strongMarkers: Array<{ name: string; kind: Exclude<BaseWorktreeProgressMarkerKind, "unmerged">; isDir?: boolean }> = [
    { name: "MERGE_HEAD", kind: "merge" },
    { name: "rebase-apply", kind: "rebase", isDir: true },
    { name: "rebase-merge", kind: "rebase", isDir: true },
    { name: "CHERRY_PICK_HEAD", kind: "cherry-pick" },
    { name: "REVERT_HEAD", kind: "revert" },
  ];
  const weakMarkers: Array<{ name: string; kind: Exclude<BaseWorktreeProgressMarkerKind, "unmerged"> }> = [
    { name: "REBASE_HEAD", kind: "rebase" },
  ];
  const activeMarkers: BaseWorktreeProgressMarker[] = [];

  for (const marker of strongMarkers) {
    const checked = await checkGitProgressMarkerAsync({ repoMainPath, gitPath, name: marker.name, kind: marker.kind, isDir: marker.isDir });
    if (!checked.ok) return checked;
    if (checked.marker) activeMarkers.push(checked.marker);
  }
  if (activeMarkers.length > 0) return { ok: true, inProgress: true, activeMarkers };

  // unmerged files：通过 index 中的未合并条目判断
  const unmerged = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "ls-files", "-u"], timeoutMs: 8000 });
  if (!unmerged.ok) {
    return { ok: false, locked: isGitLockedFailure(unmerged), stderr: String(unmerged.stderr || ""), stdout: String(unmerged.stdout || ""), error: unmerged.error };
  }
  if (String(unmerged.stdout || "").trim().length > 0) {
    return { ok: true, inProgress: true, activeMarkers: [{ name: "UNMERGED_FILES", kind: "unmerged" }] };
  }

  const staleCandidates: BaseWorktreeProgressMarker[] = [];
  for (const marker of weakMarkers) {
    const checked = await checkGitProgressMarkerAsync({ repoMainPath, gitPath, name: marker.name, kind: marker.kind });
    if (!checked.ok) return checked;
    if (checked.marker) staleCandidates.push(checked.marker);
  }
  if (staleCandidates.length === 0) return { ok: true, inProgress: false };

  if (!autoRepairStaleMarkers) {
    return { ok: true, inProgress: true, activeMarkers: staleCandidates };
  }

  const repairedStaleMarkers: Array<{ name: string; backupPath: string }> = [];
  for (const marker of staleCandidates) {
    const archived = await archiveStaleGitMarkerAsync(String(marker.absPath || ""));
    if (!archived.ok) {
      return {
        ok: true,
        inProgress: true,
        activeMarkers: staleCandidates,
        repairError: `自动归档残留标记失败（${marker.name}）：${archived.error}`,
      };
    }
    if (archived.backupPath) repairedStaleMarkers.push({ name: marker.name, backupPath: archived.backupPath });
  }
  if (repairedStaleMarkers.length > 0) {
    return { ok: true, inProgress: false, repairedStaleMarkers };
  }
  return { ok: true, inProgress: false };
}

/**
 * 中文说明：检测当前仓库是否存在 unmerged files（用于区分 stash apply 冲突与其它失败）。
 */
async function hasUnmergedFilesAsync(args: { repoMainPath: string; gitPath?: string }): Promise<{ ok: boolean; has: boolean; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "ls-files", "-u"], timeoutMs: 8000 });
  if (!res.ok) return { ok: false, has: false, locked: isGitLockedFailure(res), stderr: String(res.stderr || ""), stdout: String(res.stdout || ""), error: res.error };
  return { ok: true, has: String(res.stdout || "").trim().length > 0, locked: false, stderr: "", stdout: "" };
}

/**
 * 中文说明：记录主 worktree 的“原始位置”。
 * - 优先分支名；detached 时记录 commit sha。
 */
async function readBaseOriginalRefAsync(args: { repoMainPath: string; gitPath?: string }): Promise<
  | { ok: true; ref: { kind: "branch"; name: string } | { kind: "detached"; sha: string } }
  | { ok: false; locked: boolean; stderr: string; stdout: string; error?: string }
> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;

  const br = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "symbolic-ref", "--short", "-q", "HEAD"], timeoutMs: 8000 });
  const branch = String(br.stdout || "").trim();
  if (br.ok && branch) return { ok: true, ref: { kind: "branch", name: branch } };
  if (!br.ok && isGitLockedFailure(br)) return { ok: false, locked: true, stderr: String(br.stderr || ""), stdout: String(br.stdout || ""), error: br.error };

  const sha = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "HEAD"], timeoutMs: 8000 });
  if (!sha.ok) return { ok: false, locked: isGitLockedFailure(sha), stderr: String(sha.stderr || ""), stdout: String(sha.stdout || ""), error: sha.error };
  const full = String(sha.stdout || "").trim();
  if (!full) return { ok: false, locked: false, stderr: "", stdout: "", error: "无法读取 HEAD 提交号" };
  return { ok: true, ref: { kind: "detached", sha: full } };
}

/**
 * 中文说明：将主 worktree 切回到指定“原始位置”（分支或 detached sha）。
 */
async function switchBaseToOriginalRefAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  ref: { kind: "branch"; name: string } | { kind: "detached"; sha: string };
}): Promise<{ ok: boolean; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const ref = args.ref;
  const argv =
    ref.kind === "branch"
      ? ["-C", repoMainPath, "switch", ref.name]
      : ["-C", repoMainPath, "switch", "--detach", ref.sha];
  const res = await execGitAsync({ gitPath, argv, timeoutMs: 12_000 });
  if (res.ok) return { ok: true, locked: false, stderr: "", stdout: "" };
  return { ok: false, locked: isGitLockedFailure(res), stderr: String(res.stderr || ""), stdout: String(res.stdout || ""), error: res.error };
}

/**
 * 中文说明：读取 `refs/stash` 的 sha（无 stash 时返回空字符串）。
 */
async function readStashTopShaAsync(args: { repoMainPath: string; gitPath?: string }): Promise<{ ok: boolean; sha: string; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "-q", "--verify", "refs/stash"], timeoutMs: 8000 });
  if (res.ok) return { ok: true, sha: String(res.stdout || "").trim(), locked: false, stderr: "", stdout: "" };
  // 约定：exitCode=1 表示 refs/stash 不存在（无 stash），按 ok 处理
  if (res.exitCode === 1) return { ok: true, sha: "", locked: false, stderr: "", stdout: "" };
  return { ok: false, sha: "", locked: isGitLockedFailure(res), stderr: String(res.stderr || ""), stdout: String(res.stdout || ""), error: res.error };
}

/**
 * 中文说明：解析 `git status --porcelain` 输出，用于区分“已暂存/未暂存/未跟踪”三类状态。
 */
function analyzePorcelainStatus(porcelain: string): { hasAny: boolean; hasStaged: boolean; hasUnstagedOrUntracked: boolean } {
  const lines = String(porcelain || "")
    .split(/\r?\n/)
    .map((x) => x.trimEnd())
    .filter((x) => x.trim().length > 0);

  let hasStaged = false;
  let hasUnstagedOrUntracked = false;
  for (const line of lines) {
    if (line.startsWith("??")) {
      hasUnstagedOrUntracked = true;
      continue;
    }
    const x = line[0] || " ";
    const y = line[1] || " ";
    if (x !== " ") hasStaged = true;
    if (y !== " ") hasUnstagedOrUntracked = true;
  }
  return { hasAny: lines.length > 0, hasStaged, hasUnstagedOrUntracked };
}

/**
 * 中文说明：生成“手动恢复 stash”的命令（按顺序执行，尽量保持原有暂存状态）。
 */
function buildRestoreCommandsForStashes(stashes: RecycleBaseWorktreeStash[] | null | undefined): string {
  const list = Array.isArray(stashes) ? stashes : [];
  const staged = list.find((s) => s?.kind === "staged" && String(s.sha || "").trim().length > 0);
  const unstaged = list.find((s) => s?.kind === "unstaged" && String(s.sha || "").trim().length > 0);
  const cmds: string[] = [];
  // 兼容两种情形：
  // 1) 旧逻辑：staged/unstaged 拆成两个 stash
  // 2) 新逻辑：单 stash + index 字节快照（此时 stashes 通常只有 1 条）
  if (staged?.sha) cmds.push(`git stash apply --index ${staged.sha}`);
  if (unstaged?.sha) cmds.push(staged?.sha ? `git stash apply ${unstaged.sha}` : `git stash apply --index ${unstaged.sha}`);
  return cmds.join("\n");
}

/**
 * 中文说明：按 sha 删除 stash（优先直接 drop sha；失败时回退到按列表索引 drop）。
 */
async function dropStashByShaAsync(args: { repoMainPath: string; gitPath?: string; sha: string }): Promise<{ ok: boolean; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const sha = String(args.sha || "").trim();
  if (!sha) return { ok: false, locked: false, stderr: "", stdout: "", error: "缺少 stash 提交号" };

  // 1) 直接按 sha drop（多数 git 版本可用）
  const direct = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "stash", "drop", sha], timeoutMs: 12_000 });
  if (direct.ok) return { ok: true, locked: false, stderr: "", stdout: "" };
  if (isGitLockedFailure(direct)) return { ok: false, locked: true, stderr: String(direct.stderr || ""), stdout: String(direct.stdout || ""), error: direct.error };

  // 2) 回退：查找 sha 对应的 stash@{n} 再 drop
  const list = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "stash", "list", "--format=%H"], timeoutMs: 12_000 });
  if (!list.ok) return { ok: false, locked: isGitLockedFailure(list), stderr: String(list.stderr || ""), stdout: String(list.stdout || ""), error: list.error };
  const shas = String(list.stdout || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const idx = shas.findIndex((x) => x === sha);
  if (idx < 0) return { ok: false, locked: false, stderr: "", stdout: "", error: "未在 stash 列表中找到对应提交号" };
  const byIndex = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "stash", "drop", `stash@{${idx}}`], timeoutMs: 12_000 });
  if (byIndex.ok) return { ok: true, locked: false, stderr: "", stdout: "" };
  return { ok: false, locked: isGitLockedFailure(byIndex), stderr: String(byIndex.stderr || ""), stdout: String(byIndex.stdout || ""), error: byIndex.error };
}

/**
 * 中文说明：将“已暂存 stash”中的索引差异恢复到当前索引（不触碰工作区文件），以最大化保留原本的“未暂存”内容。
 *
 * 设计要点：
 * - 传统 `git stash apply --index` 会同时改动索引与工作区；若工作区随后还需要恢复未暂存内容，容易引入冲突或状态漂移。
 * - 这里通过 `git diff <stash>^1 <stash>^2` 取出 stash 的“索引快照”差异，再用 `git apply --cached` 只恢复索引。
 * - 会优先尝试 `--3way`（若 Git 版本不支持则自动回退），以提升在基分支发生变化后的适配能力。
 */
async function restoreIndexFromStagedStashAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  stagedStashSha: string;
}): Promise<{ ok: boolean; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const stagedStashSha = String(args.stagedStashSha || "").trim();
  if (!stagedStashSha) return { ok: false, locked: false, stderr: "", stdout: "", error: "缺少 staged stash 提交号" };

  // 1) 取出“索引快照”的差异（stash 的 ^1=当时 HEAD，^2=索引快照）
  const diff = await spawnGitAsync({
    gitPath,
    argv: ["-C", repoMainPath, "diff", "--binary", `${stagedStashSha}^1`, `${stagedStashSha}^2`],
    timeoutMs: 10 * 60_000,
  });
  if (!diff.ok) {
    return {
      ok: false,
      locked: isGitLockedFailure(diff),
      stderr: String(diff.stderr || ""),
      stdout: String(diff.stdout || ""),
      error: diff.error || "读取 staged stash 索引差异失败",
    };
  }

  const patch = String(diff.stdout || "");
  if (!patch.trim()) return { ok: true, locked: false, stderr: "", stdout: "" };

  // 2) 写入临时 patch 文件，再 git apply --cached（避免 stdin 管道实现与大 patch 内存风险）
  const patchFile = path.join(
    os.tmpdir(),
    `codexflow-staged-index-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.patch`
  );
  try {
    await fsp.writeFile(patchFile, patch, "utf8");

    const baseArgv = ["-C", repoMainPath, "apply", "--cached", "--whitespace=nowarn"];
    const try1 = await spawnGitAsync({ gitPath, argv: [...baseArgv, "--3way", patchFile], timeoutMs: 10 * 60_000 });
    if (try1.ok) return { ok: true, locked: false, stderr: "", stdout: "" };

    const msg = `${String(try1.stderr || "")}\n${String(try1.stdout || "")}`.trim();
    const isUnknown3way = /unknown option.*--3way|unknown option.*3way|unrecognized option.*--3way/i.test(msg);
    if (!isUnknown3way) {
      return { ok: false, locked: isGitLockedFailure(try1), stderr: String(try1.stderr || ""), stdout: String(try1.stdout || ""), error: try1.error || msg || "恢复索引失败" };
    }

    const try2 = await spawnGitAsync({ gitPath, argv: [...baseArgv, patchFile], timeoutMs: 10 * 60_000 });
    if (try2.ok) return { ok: true, locked: false, stderr: "", stdout: "" };
    return { ok: false, locked: isGitLockedFailure(try2), stderr: String(try2.stderr || ""), stdout: String(try2.stdout || ""), error: try2.error || "恢复索引失败" };
  } catch (e: any) {
    return { ok: false, locked: false, stderr: "", stdout: "", error: String(e?.message || e) };
  } finally {
    try { await fsp.unlink(patchFile); } catch {}
  }
}

/**
 * 中文说明：将 git 命令的 stdout 流式写入文件，避免大补丁占用内存（适用于大仓库回收）。
 */
async function spawnGitStdoutToFileAsync(opts: {
  gitPath?: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  outFile: string;
}): Promise<{ ok: boolean; exitCode: number; stderr: string; error?: string }> {
  const gitPath = String(opts?.gitPath || "").trim() || "git";
  const argv = Array.isArray(opts?.argv) ? opts.argv.map((x) => String(x)) : [];
  const cwd = typeof opts?.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd : undefined;
  const outFile = String(opts?.outFile || "").trim();
  const timeoutMs = Math.max(200, Math.min(30 * 60_000, Number(opts?.timeoutMs ?? 8000)));
  if (!outFile) return { ok: false, exitCode: -1, stderr: "", error: "缺少输出文件路径" };

  return await new Promise((resolve) => {
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timeoutHandle: any = null;

    const finalize = (res: { ok: boolean; exitCode: number; stderr: string; error?: string }) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) {
        try { clearTimeout(timeoutHandle); } catch {}
        timeoutHandle = null;
      }
      resolve(res);
    };

    try {
      const ws = fs.createWriteStream(outFile, { flags: "w" });
      const child = spawn(gitPath, argv, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 800);
      }, timeoutMs);

      child.stdout?.on("data", (buf: Buffer) => {
        try {
          const ok = ws.write(buf);
          if (!ok) {
            try { child.stdout?.pause(); } catch {}
            ws.once("drain", () => {
              try { child.stdout?.resume(); } catch {}
            });
          }
        } catch {}
      });

      child.stderr?.on("data", (buf: Buffer) => {
        const chunk = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
        stderr += chunk;
      });

      child.on("error", (err: any) => {
        try { ws.end(); } catch {}
        const msg = String(err?.message || err);
        finalize({ ok: false, exitCode: -1, stderr, error: msg });
      });

      child.on("close", (code: number | null) => {
        const exitCode = typeof code === "number" ? code : -1;
        const done = () => {
          if (timedOut) {
            finalize({ ok: false, exitCode, stderr, error: `timeout after ${timeoutMs}ms` });
            return;
          }
          if (exitCode === 0) {
            finalize({ ok: true, exitCode: 0, stderr: "" });
            return;
          }
          finalize({ ok: false, exitCode, stderr, error: `exit ${exitCode}` });
        };
        try {
          ws.end();
          ws.once("finish", done);
          ws.once("error", () => done());
        } catch {
          done();
        }
      });

      ws.on("error", (e: any) => {
        const msg = String(e?.message || e);
        try { child.kill(); } catch {}
        finalize({ ok: false, exitCode: -1, stderr, error: msg });
      });
    } catch (e: any) {
      finalize({ ok: false, exitCode: -1, stderr, error: String(e?.message || e) });
    }
  });
}

/**
 * 中文说明：解析并校验“分叉点边界”的提交号（优先使用创建时记录的 baseRefAtCreate）。
 */
async function resolveForkBaseShaAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  baseBranch: string;
  wtBranch: string;
  meta: WorktreeMeta | null;
  /** 中文说明：日志回调（用于进度 UI 展示）。 */
  onLog?: (text: string) => void;
}): Promise<{ ok: true; sha: string; source: "meta" | "merge-base" } | { ok: false; error: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const baseBranch = String(args.baseBranch || "").trim();
  const wtBranch = String(args.wtBranch || "").trim();
  const meta = args.meta;
  const log = (text: string) => {
    try { args.onLog?.(String(text ?? "")); } catch {}
  };

  const resolveCommitSha = async (ref: string): Promise<string> => {
    const r = String(ref || "").trim();
    if (!r) return "";
    const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "--verify", `${r}^{commit}`], timeoutMs: 12_000 });
    if (!res.ok) return "";
    return String(res.stdout || "").trim();
  };

  const canUseMeta =
    !!(meta && String(meta.baseRefAtCreate || "").trim()) &&
    String(meta?.baseBranch || "").trim() === baseBranch &&
    String(meta?.wtBranch || "").trim() === wtBranch;

  if (canUseMeta) {
    const sha = await resolveCommitSha(String(meta?.baseRefAtCreate || ""));
    if (sha) {
      const anc = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "merge-base", "--is-ancestor", sha, wtBranch], timeoutMs: 12_000 });
      // merge-base --is-ancestor：0=是祖先（可用），1=否，其它=错误
      if (anc.exitCode === 0) return { ok: true, sha, source: "meta" };
      if (anc.exitCode === 1) log("提示：创建记录中的分叉点已不再是源分支的祖先，回退使用 merge-base 推断。\n");
      else log("提示：校验创建记录分叉点失败，回退使用 merge-base 推断。\n");
    } else {
      log("提示：创建记录中的分叉点提交号不可用，回退使用 merge-base 推断。\n");
    }
  } else if (meta && String(meta.baseRefAtCreate || "").trim()) {
    log("提示：当前选择的基分支/源分支与创建记录不一致，改用 merge-base 推断分叉点。\n");
  }

  const mb = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "merge-base", baseBranch, wtBranch], timeoutMs: 12_000 });
  if (!mb.ok) {
    const msg = pickGitFailureText(mb) || "git merge-base failed";
    return { ok: false, error: msg };
  }
  const sha = String(mb.stdout || "").trim();
  if (!sha) return { ok: false, error: "git merge-base returned empty" };
  const verified = await resolveCommitSha(sha);
  if (!verified) return { ok: false, error: "merge-base sha is not a valid commit" };
  return { ok: true, sha: verified, source: "merge-base" };
}

/**
 * 中文说明：执行实际的回收逻辑（假设主 worktree 已处于可操作状态）。
 * - 该方法不负责处理“主 worktree 脏”的策略；由外层决定是提示用户还是自动 stash。
 */
async function recycleWorktreeCoreAsync(args: {
  wt: string;
  repoMainPath: string;
  baseBranch: string;
  wtBranch: string;
  range: "since_fork" | "full";
  /** 中文说明：仅在 range=since_fork 时使用的分叉点边界提交号。 */
  forkBaseSha?: string;
  mode: RecycleMode;
  gitPath?: string;
  commitMessage?: string;
  /** 中文说明：回收过程日志回调（用于进度 UI 展示）。 */
  onLog?: (text: string) => void;
}): Promise<{ ok: true } | { ok: false; errorCode?: RecycleWorktreeErrorCode; stderr: string; stdout: string; error?: string }> {
  const wt = toFsPathAbs(args.wt);
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const baseBranch = String(args.baseBranch || "").trim();
  const wtBranch = String(args.wtBranch || "").trim();
  const gitPath = args.gitPath;
  const log = (text: string) => {
    try { args.onLog?.(String(text ?? "")); } catch {}
  };
  const runGit = async (argv: string[], timeoutMs: number) => {
    log(`\n$ git ${argv.join(" ")}\n`);
    return await spawnGitAsync({ gitPath, argv, timeoutMs, onStdout: log, onStderr: log });
  };
  // 中文说明：回收的 merge/rebase 在大仓库上可能较慢，超时需要比普通命令更宽松。
  const mergeTimeoutMs = 10 * 60_000;
  const commitTimeoutMs = 60_000;
  const rebaseTimeoutMs = 30 * 60_000;
  const ffTimeoutMs = 5 * 60_000;
  const diffTimeoutMs = 10 * 60_000;
  const applyTimeoutMs = 10 * 60_000;
  const rollbackTimeoutMs = 5 * 60_000;

  if (args.mode === "squash") {
    const sw = await runGit(["-C", repoMainPath, "switch", baseBranch], 12_000);
    if (!sw.ok) return { ok: false, errorCode: isGitLockedFailure(sw) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(sw.stderr || ""), stdout: String(sw.stdout || ""), error: sw.error };

    if (args.range === "since_fork") {
      const forkBaseSha = String(args.forkBaseSha || "").trim();
      if (!forkBaseSha) return { ok: false, errorCode: "INVALID_ARGS", stderr: "", stdout: "", error: "缺少 forkBaseSha" };

      // A) 生成补丁（写入临时文件），避免把大 diff 拉进内存/日志
      const patchFile = path.join(
        os.tmpdir(),
        `codexflow-recycle-diff-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.patch`
      );
      try {
        log(`\n$ git -C "${repoMainPath}" diff --binary ${forkBaseSha} ${wtBranch} > "${patchFile}"\n`);
        const diff = await spawnGitStdoutToFileAsync({ gitPath, argv: ["-C", repoMainPath, "diff", "--binary", forkBaseSha, wtBranch], timeoutMs: diffTimeoutMs, outFile: patchFile });
        if (!diff.ok) {
          return {
            ok: false,
            errorCode: isGitLockedFailure({ error: diff.error, stderr: diff.stderr, stdout: "" }) ? "BASE_WORKTREE_LOCKED" : undefined,
            stderr: String(diff.stderr || ""),
            stdout: "",
            error: diff.error,
          };
        }

        const st = await fsp.stat(patchFile).catch(() => null as any);
        const size = typeof st?.size === "number" ? st.size : 0;
        if (size <= 0) {
          log("无可回收变更：分叉点之后没有差异。\n");
          return { ok: true };
        }

        // B) 应用补丁到主 worktree（带 --3way 优先，失败自动回退）
        const baseArgv = ["-C", repoMainPath, "apply", "--index", "--whitespace=nowarn"];
        const try1 = await runGit([...baseArgv, "--3way", patchFile], applyTimeoutMs);
        if (!try1.ok) {
          const msg = `${String(try1.stderr || "")}\n${String(try1.stdout || "")}`.trim();
          const isUnknown3way = /unknown option.*--3way|unknown option.*3way|unrecognized option.*--3way/i.test(msg);
          if (!isUnknown3way) {
            log("提示：补丁应用失败，正在回滚主 worktree 到干净状态。\n");
            try { await runGit(["-C", repoMainPath, "reset", "--hard"], rollbackTimeoutMs); } catch {}
            try { await runGit(["-C", repoMainPath, "clean", "-fd"], rollbackTimeoutMs); } catch {}
            return { ok: false, errorCode: isGitLockedFailure(try1) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(try1.stderr || ""), stdout: String(try1.stdout || ""), error: try1.error || msg || "git apply failed" };
          }

          const try2 = await runGit([...baseArgv, patchFile], applyTimeoutMs);
          if (!try2.ok) {
            log("提示：补丁应用失败，正在回滚主 worktree 到干净状态。\n");
            try { await runGit(["-C", repoMainPath, "reset", "--hard"], rollbackTimeoutMs); } catch {}
            try { await runGit(["-C", repoMainPath, "clean", "-fd"], rollbackTimeoutMs); } catch {}
            return { ok: false, errorCode: isGitLockedFailure(try2) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(try2.stderr || ""), stdout: String(try2.stdout || ""), error: try2.error || "git apply failed" };
          }
        }

        // C) 若无改动则不提交（避免 “nothing to commit” 报错）
        const st2 = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "status", "--porcelain"], timeoutMs: 8000 });
        if (st2.ok && String(st2.stdout || "").trim().length === 0) {
          log("无可回收变更：补丁应用后主 worktree 仍无改动。\n");
          return { ok: true };
        }

        const msg = String(args.commitMessage || "").trim() || `squash: ${wtBranch} -> ${baseBranch}`;
        const commit = await runGit(["-C", repoMainPath, "commit", "-m", msg], commitTimeoutMs);
        if (!commit.ok) {
          const st3 = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "status", "--porcelain"], timeoutMs: 8000 });
          if (st3.ok && String(st3.stdout || "").trim().length === 0) return { ok: true };
          return { ok: false, errorCode: isGitLockedFailure(commit) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(commit.stderr || ""), stdout: String(commit.stdout || ""), error: commit.error };
        }
        return { ok: true };
      } finally {
        try { await fsp.unlink(patchFile); } catch {}
      }
    }

    // 完整回收：沿用原有 squash 流程
    const merge = await runGit(["-C", repoMainPath, "merge", "--squash", wtBranch], mergeTimeoutMs);
    if (!merge.ok) return { ok: false, errorCode: isGitLockedFailure(merge) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(merge.stderr || ""), stdout: String(merge.stdout || ""), error: merge.error };

    const st2 = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "status", "--porcelain"], timeoutMs: 8000 });
    if (st2.ok && String(st2.stdout || "").trim().length === 0) {
      log("无可回收变更：当前分支与基分支无差异。\n");
      return { ok: true };
    }

    const msg = String(args.commitMessage || "").trim() || `squash: ${wtBranch} -> ${baseBranch}`;
    const commit = await runGit(["-C", repoMainPath, "commit", "-m", msg], commitTimeoutMs);
    if (!commit.ok) {
      const st3 = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "status", "--porcelain"], timeoutMs: 8000 });
      if (st3.ok && String(st3.stdout || "").trim().length === 0) return { ok: true };
      return { ok: false, errorCode: isGitLockedFailure(commit) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(commit.stderr || ""), stdout: String(commit.stdout || ""), error: commit.error };
    }
    return { ok: true };
  }

  // rebase 模式：在 worktree 上 rebase，然后在主 worktree fast-forward
  const wtDirty = await execGitAsync({ gitPath, argv: ["-C", wt, "status", "--porcelain"], timeoutMs: 8000 });
  if (wtDirty.ok && String(wtDirty.stdout || "").trim().length > 0) {
    return { ok: false, errorCode: "WORKTREE_DIRTY", stderr: "", stdout: "" };
  }

  const swWt = await runGit(["-C", wt, "switch", wtBranch], 12_000);
  if (!swWt.ok) return { ok: false, errorCode: isGitLockedFailure(swWt) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(swWt.stderr || ""), stdout: String(swWt.stdout || ""), error: swWt.error };

  const rebase =
    args.range === "since_fork"
      ? (() => {
          const forkBaseSha = String(args.forkBaseSha || "").trim();
          if (!forkBaseSha) return null;
          return runGit(["-C", wt, "rebase", "--onto", baseBranch, forkBaseSha, wtBranch], rebaseTimeoutMs);
        })()
      : runGit(["-C", wt, "rebase", baseBranch], rebaseTimeoutMs);
  if (!rebase) return { ok: false, errorCode: "INVALID_ARGS", stderr: "", stdout: "", error: "缺少 forkBaseSha" };
  const rebaseRes = await rebase;
  if (!rebaseRes.ok) return { ok: false, errorCode: isGitLockedFailure(rebaseRes) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(rebaseRes.stderr || ""), stdout: String(rebaseRes.stdout || ""), error: rebaseRes.error };

  const swMain = await runGit(["-C", repoMainPath, "switch", baseBranch], 12_000);
  if (!swMain.ok) return { ok: false, errorCode: isGitLockedFailure(swMain) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(swMain.stderr || ""), stdout: String(swMain.stdout || ""), error: swMain.error };

  const ff = await runGit(["-C", repoMainPath, "merge", "--ff-only", wtBranch], ffTimeoutMs);
  if (!ff.ok) return { ok: false, errorCode: isGitLockedFailure(ff) ? "BASE_WORKTREE_LOCKED" : undefined, stderr: String(ff.stderr || ""), stdout: String(ff.stdout || ""), error: ff.error };
  return { ok: true };
}

/**
 * 回收 worktree 分支到基分支（支持 squash 与 rebase 两种模式）。
 */
export async function recycleWorktreeAsync(req: RecycleWorktreeRequest): Promise<RecycleWorktreeResult> {
  const wt = toFsPathAbs(req.worktreePath);

  /**
   * 中文说明：安全写日志，避免日志回调抛错影响主流程。
   */
  const log = (text: string) => {
    try { req.onLog?.(String(text ?? "")); } catch {}
  };

  const gitPath = req.gitPath;
  const baseBranch = String(req.baseBranch || "").trim();
  const wtBranch = String(req.wtBranch || "").trim();
  if (!baseBranch || !wtBranch) return { ok: false, errorCode: "INVALID_ARGS", details: { repoMainPath: undefined, baseBranch, wtBranch } };

  // 1) 解析 repoMainPath：优先使用创建记录；缺失则尝试从 git worktree 信息推断
  let meta: WorktreeMeta | null = getWorktreeMeta(wt);
  let repoMainPath = toFsPathAbs(String(meta?.repoMainPath || ""));
  if (!repoMainPath) {
    const inferred = await resolveRepoMainPathFromWorktreeAsync({ worktreePath: wt, gitPath, timeoutMs: 12_000 });
    if (!inferred.ok) return { ok: false, errorCode: "META_MISSING", details: { repoMainPath: undefined, error: inferred.error } };
    repoMainPath = inferred.repoMainPath;
  }

  // 2) 记录/更新 base/wt 选择（用于下次默认值，以及 delete/reset 等后续操作）
  try {
    const nextMeta = buildNextWorktreeMeta({ existing: meta, repoMainPath, baseBranch, wtBranch });
    setWorktreeMeta(wt, nextMeta);
    meta = nextMeta;
  } catch {}

  const repoKey = toFsPathKey(repoMainPath);
  return await runExclusiveInRepoAsync(repoKey, async () => {
    const rangeLabel = req.range === "full" ? "full" : "since_fork";
    log(`开始回收 worktree\nworktreePath: ${wt}\nrepoMainPath: ${repoMainPath}\nbaseBranch: ${baseBranch}\nwtBranch: ${wtBranch}\nrange: ${rangeLabel}\nmode: ${req.mode}\n\n`);

    // A) 二次校验：中断/冲突态直接拒绝自动化（同时也避免误导 UI 去弹“继续 stash”）
    const inProg = await detectBaseWorktreeInProgressAsync({ repoMainPath, gitPath, autoRepairStaleMarkers: true });
    if (!inProg.ok) {
      const code: RecycleWorktreeErrorCode = inProg.locked ? "BASE_WORKTREE_LOCKED" : "UNKNOWN";
      return { ok: false, errorCode: code, details: { repoMainPath, baseBranch, wtBranch, stderr: inProg.stderr, stdout: inProg.stdout, error: inProg.error } };
    }
    if ((inProg.repairedStaleMarkers || []).length > 0) {
      const repairedText = (inProg.repairedStaleMarkers || [])
        .map((item) => `${item.name} -> ${item.backupPath}`)
        .join("\n");
      log(`检测到主 worktree 存在过期 Git 标记，已自动归档并继续：\n${repairedText}\n`);
    }
    if (inProg.inProgress) {
      const markerText = formatProgressMarkers(inProg.activeMarkers || []);
      const extraError = String(inProg.repairError || "").trim();
      if (markerText) log(`主 worktree 仍存在进行中的 Git 状态：${markerText}\n`);
      if (extraError) log(`${extraError}\n`);
      return { ok: false, errorCode: "BASE_WORKTREE_IN_PROGRESS", details: { repoMainPath, baseBranch, wtBranch, error: extraError || undefined } };
    }

    // 主 worktree 是否干净
    const mainStatus = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "status", "--porcelain"], timeoutMs: 8000 });
    if (!mainStatus.ok) {
      const code: RecycleWorktreeErrorCode = isGitLockedFailure(mainStatus) ? "BASE_WORKTREE_LOCKED" : "UNKNOWN";
      return { ok: false, errorCode: code, details: { repoMainPath, baseBranch, wtBranch, stderr: String(mainStatus.stderr || ""), stdout: String(mainStatus.stdout || ""), error: mainStatus.error } };
    }
    const isMainDirty = String(mainStatus.stdout || "").trim().length > 0;
    const mainAnalyze = analyzePorcelainStatus(String(mainStatus.stdout || ""));

    // 默认：主 worktree 脏则提示 UI 弹窗，不直接失败结束
    if (isMainDirty && req.autoStashBaseWorktree !== true) {
      log("检测到主 worktree 不干净：等待用户确认是否自动 stash/恢复。\n");
      return { ok: false, errorCode: "BASE_WORKTREE_DIRTY", details: { repoMainPath, baseBranch, wtBranch } };
    }

    // B/C) 自动 stash（仅当主 worktree 脏且用户确认继续）
    const willAutoStash = isMainDirty && req.autoStashBaseWorktree === true;
    let originalRef: RecycleWorktreeDetails["originalRef"] | undefined = undefined;
    let stashes: RecycleBaseWorktreeStash[] = [];
    let baseSnapshot: WorktreeStateSnapshot | null = null;

    if (willAutoStash) {
      log("开始自动 stash 主 worktree（用于回收期间保持主 worktree 干净）。\n");
      const orig = await readBaseOriginalRefAsync({ repoMainPath, gitPath });
      if (!orig.ok) {
        const code: RecycleWorktreeErrorCode = orig.locked ? "BASE_WORKTREE_LOCKED" : "UNKNOWN";
        return { ok: false, errorCode: code, details: { repoMainPath, baseBranch, wtBranch, stderr: orig.stderr, stdout: orig.stdout, error: orig.error } };
      }
      originalRef = orig.ref;

      const taskId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      const time = new Date().toISOString();
      const markerBase = `codexflow:recycle wt=${wtBranch} base=${baseBranch} at=${time} id=${taskId}`;
      const markerSnapshot = `${markerBase} kind=snapshot`;
      const snap = await createWorktreeStateSnapshotAsync({ repoMainPath, gitPath, stashMessage: markerSnapshot, onLog: req.onLog });
      if (!snap.ok) {
        const code: RecycleWorktreeErrorCode = snap.locked ? "BASE_WORKTREE_LOCKED" : "BASE_WORKTREE_STASH_FAILED";
        return { ok: false, errorCode: code, details: { repoMainPath, baseBranch, wtBranch, originalRef, stderr: snap.stderr, stdout: snap.stdout, error: snap.error } };
      }
      baseSnapshot = snap.snapshot;
      const kind: RecycleBaseWorktreeStashKind = mainAnalyze.hasStaged && !mainAnalyze.hasUnstagedOrUntracked ? "staged" : "unstaged";
      stashes = [{ kind, sha: baseSnapshot.stashSha, message: baseSnapshot.stashMessage }];

      // 复验：stash 完毕后主 worktree 必须干净，否则中止并提示外部处理（stash 已创建，避免用户担心丢改动）
      const st2 = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "status", "--porcelain"], timeoutMs: 8000 });
      if (!st2.ok) {
        const code: RecycleWorktreeErrorCode = isGitLockedFailure(st2) ? "BASE_WORKTREE_LOCKED" : "UNKNOWN";
        return {
          ok: false,
          errorCode: code,
          details: {
            repoMainPath,
            baseBranch,
            wtBranch,
            originalRef,
            stashes,
            suggestedRestoreCommand: baseSnapshot ? buildRestoreCommandsForWorktreeStateSnapshot(baseSnapshot) : buildRestoreCommandsForStashes(stashes),
            stderr: String(st2.stderr || ""),
            stdout: String(st2.stdout || ""),
            error: st2.error,
          },
        };
      }
      if (String(st2.stdout || "").trim().length > 0) {
        return {
          ok: false,
          errorCode: "BASE_WORKTREE_DIRTY_AFTER_STASH",
          details: { repoMainPath, baseBranch, wtBranch, originalRef, stashes, suggestedRestoreCommand: baseSnapshot ? buildRestoreCommandsForWorktreeStateSnapshot(baseSnapshot) : buildRestoreCommandsForStashes(stashes) },
        };
      }
    }

    // D) 执行回收（复用既有 squash/rebase 流程）
    // 中文说明：当选择“仅分叉点之后”时，不做“失败即自动回退完整回收”，避免误扩大回收范围。
    const requestedRange = req.range === "full" ? "full" : "since_fork";
    let forkBaseSha: string | undefined = undefined;

    if (requestedRange === "since_fork") {
      const manualRef = String(req.forkBaseRef || "").trim();

      // 1) 手动分叉点：优先使用，并做严格校验（必须为源分支祖先）
      if (manualRef) {
        const rp = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "--verify", `${manualRef}^{commit}`], timeoutMs: 12_000 });
        if (!rp.ok) {
          return { ok: false, errorCode: "FORK_POINT_INVALID", details: { repoMainPath, baseBranch, wtBranch, error: pickGitFailureText(rp) || "分叉点提交号无效" } };
        }
        const sha = String(rp.stdout || "").trim();
        const anc = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "merge-base", "--is-ancestor", sha, wtBranch], timeoutMs: 12_000 });
        // merge-base --is-ancestor：0=是祖先（可用），1=否，其它=错误
        if (anc.exitCode !== 0) {
          const msg = anc.exitCode === 1 ? "分叉点不是源分支的祖先" : (pickGitFailureText(anc) || "校验分叉点失败");
          return { ok: false, errorCode: "FORK_POINT_INVALID", details: { repoMainPath, baseBranch, wtBranch, error: msg } };
        }
        forkBaseSha = sha;
        log(`分叉点边界：${forkBaseSha}（来源：手动指定）。\n`);
      } else {
        // 2) 自动分叉点：优先创建记录，否则 merge-base
        const fork = await resolveForkBaseShaAsync({ repoMainPath, gitPath, baseBranch, wtBranch, meta, onLog: req.onLog });
        if (!fork.ok) {
          return { ok: false, errorCode: "FORK_POINT_UNAVAILABLE", details: { repoMainPath, baseBranch, wtBranch, error: fork.error } };
        }
        forkBaseSha = fork.sha;
        const sourceLabel = fork.source === "meta" ? "创建记录" : "merge-base";
        log(`分叉点边界：${forkBaseSha}（来源：${sourceLabel}）。\n`);
      }
    }

    log(`开始执行回收（范围：${requestedRange === "since_fork" ? "仅分叉点之后" : "完整"}；模式：${req.mode}）。\n`);
    const core = await recycleWorktreeCoreAsync({ wt, repoMainPath, baseBranch, wtBranch, range: requestedRange, forkBaseSha, mode: req.mode, gitPath, commitMessage: req.commitMessage, onLog: req.onLog });
    if (!core.ok) {
      // 失败兜底：若已 stash，则不要自动恢复，避免叠加到冲突/中断态
      if (stashes.length > 0) {
        return {
          ok: false,
          errorCode: core.errorCode || "RECYCLE_FAILED",
          details: {
            repoMainPath,
            baseBranch,
            wtBranch,
            originalRef,
            stashes,
            suggestedRestoreCommand: baseSnapshot ? buildRestoreCommandsForWorktreeStateSnapshot(baseSnapshot) : buildRestoreCommandsForStashes(stashes),
            stderr: core.stderr,
            stdout: core.stdout,
            error: core.error,
          },
        };
      }
      const code: RecycleWorktreeErrorCode = core.errorCode || "UNKNOWN";
      return { ok: false, errorCode: code, details: { repoMainPath, baseBranch, wtBranch, stderr: core.stderr, stdout: core.stdout, error: core.error } };
    }

    // 未启用 stash：整体成功
    if (stashes.length === 0) return { ok: true };

    // E) 回收成功后自动恢复（强恢复 + drop）
    if (originalRef) {
      log("回收完成：正在切回主 worktree 原始位置。\n");
      const back = await switchBaseToOriginalRefAsync({ repoMainPath, gitPath, ref: originalRef });
      if (!back.ok) {
        return {
          ok: true,
          warningCode: "BASE_WORKTREE_RESTORE_FAILED",
          details: {
            repoMainPath,
            baseBranch,
            wtBranch,
            originalRef,
            stashes,
            suggestedRestoreCommand: baseSnapshot ? buildRestoreCommandsForWorktreeStateSnapshot(baseSnapshot) : buildRestoreCommandsForStashes(stashes),
            stderr: back.stderr,
            stdout: back.stdout,
            error: back.error,
          },
        };
      }
    }

    const stagedStash = stashes.find((s) => s.kind === "staged");
    const unstagedStash = stashes.find((s) => s.kind === "unstaged");

    // 新策略：强恢复（工作区快照 + index 字节快照）——只覆盖，不做 apply/merge
    if (baseSnapshot) {
      log(`正在强恢复主 worktree（stash: ${baseSnapshot.stashSha}）。\n`);
      const restore = await restoreWorktreeStateSnapshotAsync({ repoMainPath, gitPath, snapshot: baseSnapshot, onLog: req.onLog });
      if (!restore.ok) {
        const unmerged = await hasUnmergedFilesAsync({ repoMainPath, gitPath });
        const isConflict = unmerged.ok && unmerged.has;
        return {
          ok: true,
          warningCode: isConflict ? "BASE_WORKTREE_RESTORE_CONFLICT" : "BASE_WORKTREE_RESTORE_FAILED",
          details: {
            repoMainPath,
            baseBranch,
            wtBranch,
            originalRef,
            stashes,
            suggestedRestoreCommand: baseSnapshot ? buildRestoreCommandsForWorktreeStateSnapshot(baseSnapshot) : buildRestoreCommandsForStashes(stashes),
            stderr: restore.stderr,
            stdout: restore.stdout,
            error: restore.error,
          },
        };
      }
    } else if (unstagedStash?.sha || stagedStash?.sha) {
      // 兜底：理论上不会进入（willAutoStash=true 时一定会有 baseSnapshot）
      return {
        ok: true,
        warningCode: "BASE_WORKTREE_RESTORE_FAILED",
        details: { repoMainPath, baseBranch, wtBranch, originalRef, stashes, suggestedRestoreCommand: buildRestoreCommandsForStashes(stashes), stderr: "", stdout: "", error: "缺少快照信息，无法自动恢复" },
      };
    }

    const dropCmd = stashes.map((s) => (s?.sha ? `git stash drop ${s.sha}` : "")).filter(Boolean).join("\n");
    for (const s of stashes) {
      if (!s?.sha) continue;
      const drop = await dropStashByShaAsync({ repoMainPath, gitPath, sha: s.sha });
      if (!drop.ok) {
        return {
          ok: true,
          warningCode: "BASE_WORKTREE_STASH_DROP_FAILED",
          details: { repoMainPath, baseBranch, wtBranch, originalRef, stashes, suggestedRestoreCommand: dropCmd, stderr: drop.stderr, stdout: drop.stdout, error: drop.error },
        };
      }
    }

    // 清理快照目录（失败不影响主流程；失败时快照仍可作为兜底保留在 .git 下）
    if (baseSnapshot?.snapshotDir) {
      try { await cleanupWorktreeStateSnapshotAsync({ snapshotDir: baseSnapshot.snapshotDir }); } catch {}
    }

    return { ok: true };
  });
}

/**
 * 删除 worktree（git worktree remove）并按需删除分支（未合并需强确认）。
 */
export async function removeWorktreeAsync(req: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
  const wt = toFsPathAbs(req.worktreePath);
  const key = toFsPathKey(wt);
  if (!key) return { ok: false, removedWorktree: false, removedBranch: false, error: "missing worktreePath" };

  // 幂等/防重：同一路径同时只允许一个删除任务执行
  const existing = removeWorktreeTaskByPathKey.get(key);
  if (existing) return await existing;

  const task = (async (): Promise<RemoveWorktreeResult> => {
    const gitPath = req.gitPath;
    const meta = getWorktreeMeta(wt);
    let repoMainPath = toFsPathAbs(String(meta?.repoMainPath || ""));
    if (!repoMainPath) {
      const inferred = await resolveRepoMainPathFromWorktreeAsync({ worktreePath: wt, gitPath, timeoutMs: 12_000 });
      if (!inferred.ok) return { ok: false, removedWorktree: false, removedBranch: false, error: inferred.error || "missing repoMainPath" };
      repoMainPath = inferred.repoMainPath;
    }

    // 中文说明：deleteBranch=true 时需要的关键信息尽量在 remove 之前解析（避免目录被移除后无法读取）
    let resolvedWtBranch = String(meta?.wtBranch || "").trim();
    if (req.deleteBranch && !resolvedWtBranch) {
      const inferred = await resolveWorktreeBranchNameAsync({ repoDir: repoMainPath, worktreePath: wt, gitPath, timeoutMs: 12_000 });
      if (inferred.ok && !inferred.detached) resolvedWtBranch = String(inferred.branch || "").trim();
    }

    let baseRefForMergedCheck = String(meta?.baseBranch || "").trim();
    if (req.deleteBranch && !baseRefForMergedCheck) {
      const cur = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "symbolic-ref", "--short", "-q", "HEAD"], timeoutMs: 8000 });
      baseRefForMergedCheck = String(cur.stdout || "").trim() || "HEAD";
    }
    // 中文说明：大仓库/大工作区删除可能很慢（主要耗时在目录移除），需要更长超时避免误判失败。
    const removeTimeoutMs = 15 * 60_000;

    // 1) 先移除 worktree
    // 注意：当“分支未合并需二次确认”时，第一次调用可能已经移除了 worktree；
    // 为支持二次调用强制删分支，需要对“worktree 已不存在/未登记”的错误做幂等处理。
    let removedWorktree = false;
    const rmArgv = ["-C", repoMainPath, "worktree", "remove", ...(req.forceRemoveWorktree ? ["--force"] : []), wt];
    const rm = await spawnGitAsync({ gitPath, argv: rmArgv, timeoutMs: removeTimeoutMs });
    if (!rm.ok) {
      const msg = rm.stderr.trim() || rm.error || "git worktree remove failed";
      // 常见：worktree 有未提交修改，需要 --force
      if (!req.forceRemoveWorktree && /not clean|contains modified|modified files/i.test(msg)) {
        return { ok: false, removedWorktree: false, removedBranch: false, needsForceRemoveWorktree: true, error: msg };
      }
      // 若 worktree 已被移除/不再登记，但用户仍希望删除分支，则继续执行分支删除逻辑
      const alreadyGone = /not a working tree|is not a working tree|unknown worktree|not registered|does not exist|already removed|No such file|no such file/i.test(msg);
      if (req.deleteBranch && alreadyGone) {
        removedWorktree = true;
      } else {
        return { ok: false, removedWorktree: false, removedBranch: false, error: msg };
      }
    } else {
      removedWorktree = true;
    }

    let removedBranch = false;
    if (req.deleteBranch) {
      const wtBranch = String(resolvedWtBranch || "").trim();
      const baseRef = String(baseRefForMergedCheck || "").trim() || "HEAD";
      if (wtBranch) {
        const merged = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "merge-base", "--is-ancestor", wtBranch, baseRef], timeoutMs: 10_000 });
        // merge-base --is-ancestor：0=是祖先（已合并），1=否，其它=错误
        if (merged.exitCode !== 0 && merged.exitCode !== 1) {
          return { ok: false, removedWorktree, removedBranch: false, error: merged.error || merged.stderr.trim() || "git merge-base failed" };
        }
        const isMerged = merged.exitCode === 0;
        if (!isMerged && !req.forceDeleteBranch) {
          return { ok: false, removedWorktree, removedBranch: false, needsForceDeleteBranch: true, error: "branch not merged" };
        }
        const delArgv = ["-C", repoMainPath, "branch", isMerged ? "-d" : "-D", wtBranch];
        const del = await execGitAsync({ gitPath, argv: delArgv, timeoutMs: 10_000 });
        if (!del.ok) {
          return { ok: false, removedWorktree, removedBranch: false, error: del.error || del.stderr.trim() || "git branch delete failed" };
        }
        removedBranch = true;
      }
    }

    // 2) 清理元数据：无论是否删除分支，只要 worktree 已删除就应移除映射
    try { if (removedWorktree) deleteWorktreeMeta(wt); } catch {}
    // 3) 兜底：强制删除目录（避免残留阻塞后续创建/删除）
    try { if (removedWorktree) await removeWorktreeDirBestEffortAsync(wt); } catch {}
    return { ok: true, removedWorktree, removedBranch };
  })();

  removeWorktreeTaskByPathKey.set(key, task);
  try {
    return await task;
  } finally {
    removeWorktreeTaskByPathKey.delete(key);
  }
}
