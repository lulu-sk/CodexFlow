// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { execGitAsync, spawnGitAsync } from "./exec";
import { createWorktreesAsync, type CreatedWorktree } from "./worktreeOps";
import { deleteWorktreeMeta } from "../stores/worktreeMetaStore";

export type WorktreeCreateTaskStatus = "running" | "canceling" | "canceled" | "success" | "error";

export type WorktreeCreateTaskItemStatus = "creating" | "success" | "error" | "canceled";

export type WorktreeCreateTaskItemSnapshot = {
  /** 条目唯一 key（优先使用 worktreePath 归一化 key）。 */
  key: string;
  providerId: "codex" | "claude" | "gemini";
  worktreePath: string;
  wtBranch: string;
  index: number;
  status: WorktreeCreateTaskItemStatus;
  updatedAt: number;
  error?: string;
  warnings?: string[];
};

export type WorktreeCreateTaskSnapshot = {
  taskId: string;
  repoDir: string;
  baseBranch: string;
  instances: Array<{ providerId: "codex" | "claude" | "gemini"; count: number }>;
  copyRules: boolean;
  status: WorktreeCreateTaskStatus;
  createdAt: number;
  updatedAt: number;
  /** 当前已累计日志字符数（用于增量拉取）。 */
  logSize: number;
  totalCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  allCompleted: boolean;
  worktreeStates: WorktreeCreateTaskItemSnapshot[];
  error?: string;
  items?: CreatedWorktree[];
};

type WorktreeCreateTaskState = WorktreeCreateTaskSnapshot & {
  log: string;
  cancelRequested: boolean;
  abortController: AbortController;
  /** 中文说明：已成功创建的 worktree 列表（用于取消时回滚清理）。 */
  createdSoFar: CreatedWorktree[];
  /** 中文说明：本任务已规划过的 worktree（用于取消时清理全部目标目录/分支）。 */
  plannedSoFar: Array<{ worktreePath: string; wtBranch: string }>;
  /** 中文说明：创建任务使用的 gitPath（用于取消时清理）。 */
  gitPath?: string;
};

/**
 * 中文说明：管理 worktree 创建后台任务（可查询进度与输出日志）。
 *
 * 设计目标：
 * - 创建过程中可关闭 UI；任务继续在主进程后台执行
 * - 重新打开 UI 时可通过 taskId 增量获取日志与状态
 * - 大仓库兼容：git worktree add 使用更长超时 + spawn 流式输出
 */
export class WorktreeCreateTaskManager {
  private readonly tasks = new Map<string, WorktreeCreateTaskState>();
  private readonly runningByRepoKey = new Map<string, string>();
  private readonly maxLogChars: number;
  private readonly cleanupTtlMs: number;

  constructor(args?: { maxLogChars?: number; cleanupTtlMs?: number }) {
    this.maxLogChars = Math.max(32_000, Math.min(50 * 1024 * 1024, Math.floor(Number(args?.maxLogChars ?? 8 * 1024 * 1024))));
    this.cleanupTtlMs = Math.max(10_000, Math.min(6 * 60 * 60_000, Math.floor(Number(args?.cleanupTtlMs ?? 30 * 60_000))));
  }

  /**
   * 启动（或复用）指定仓库的创建任务。
   */
  public startOrReuse(args: {
    repoDir: string;
    baseBranch: string;
    instances: Array<{ providerId: "codex" | "claude" | "gemini"; count: number }>;
    gitPath?: string;
    copyRules?: boolean;
  }): { ok: boolean; taskId?: string; reused?: boolean; error?: string } {
    const repoDir = String(args?.repoDir || "").trim();
    const baseBranch = String(args?.baseBranch || "").trim();
    const instancesRaw = Array.isArray(args?.instances) ? args.instances : [];
    const instances = instancesRaw
      .map((x) => ({ providerId: x.providerId, count: Math.max(0, Math.floor(Number(x.count) || 0)) }))
      .filter((x) => x.count > 0);
    if (!repoDir) return { ok: false, error: "missing repoDir" };
    if (!baseBranch) return { ok: false, error: "missing baseBranch" };
    if (instances.length === 0) return { ok: false, error: "missing instances" };

    const repoKey = toFsPathKey(repoDir);
    const existingTaskId = this.runningByRepoKey.get(repoKey);
    if (existingTaskId) {
      const existing = this.tasks.get(existingTaskId);
      // 中文说明：canceling 期间仍视为“仓库任务占用中”，避免并发创建导致 git lock / worktree 状态不一致
      if (existing && (existing.status === "running" || existing.status === "canceling")) {
        return { ok: true, taskId: existingTaskId, reused: true };
      }
      // 异常兜底：清理脏映射
      try { this.runningByRepoKey.delete(repoKey); } catch {}
    }

    const taskId = this.uid();
    const now = Date.now();
    const totalCount = instances.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.count) || 0)), 0);
    const state: WorktreeCreateTaskState = {
      taskId,
      repoDir,
      baseBranch,
      instances,
      copyRules: args?.copyRules === true,
      status: "running",
      createdAt: now,
      updatedAt: now,
      logSize: 0,
      totalCount,
      completedCount: 0,
      successCount: 0,
      failedCount: 0,
      allCompleted: totalCount <= 0,
      worktreeStates: [],
      log: "",
      cancelRequested: false,
      abortController: new AbortController(),
      createdSoFar: [],
      plannedSoFar: [],
      gitPath: typeof args?.gitPath === "string" ? String(args.gitPath || "").trim() || undefined : undefined,
    };
    this.tasks.set(taskId, state);
    this.runningByRepoKey.set(repoKey, taskId);

    // 后台执行：不阻塞 IPC 回包
    void this.runCreateTask(taskId, { ...args, instances }).catch(() => {});

    return { ok: true, taskId, reused: false };
  }

  /**
   * 获取任务快照，并按 from 偏移增量返回日志 append。
   */
  public get(args: { taskId: string; from?: number }): { ok: boolean; task?: WorktreeCreateTaskSnapshot; append?: string; error?: string } {
    const taskId = String(args?.taskId || "").trim();
    if (!taskId) return { ok: false, error: "missing taskId" };
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "task not found" };
    const from = Math.max(0, Math.min(Number.isFinite(Number(args?.from)) ? Math.floor(Number(args?.from)) : 0, t.log.length));
    const append = from >= t.log.length ? "" : t.log.slice(from);
    return { ok: true, task: this.snapshot(t), append };
  }

  /**
   * 中文说明：请求取消指定创建任务（会尽快终止 git 子进程，并回滚清理已创建资源）。
   */
  public cancel(args: { taskId: string }): { ok: boolean; alreadyFinished?: boolean; error?: string } {
    const taskId = String(args?.taskId || "").trim();
    if (!taskId) return { ok: false, error: "missing taskId" };
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "task not found" };
    if (t.status !== "running" && t.status !== "canceling") return { ok: true, alreadyFinished: true };
    if (!t.cancelRequested) {
      t.cancelRequested = true;
      t.status = "canceling";
      this.appendLog(taskId, "\n收到取消请求，正在终止并清理…\n");
      try { t.abortController.abort(); } catch {}
    }
    this.refreshTaskProgress(taskId);
    return { ok: true };
  }

  /**
   * 中文说明：为 worktree 进度条目生成稳定 key（优先使用路径 key，兜底 provider/index/branch）。
   */
  private buildWorktreeItemKey(args: { worktreePath: string; providerId: string; index: number; wtBranch: string }): string {
    const byPath = toFsPathKey(args.worktreePath);
    if (byPath) return byPath;
    const providerId = String(args.providerId || "").trim().toLowerCase() || "unknown";
    const index = Math.max(1, Math.floor(Number(args.index) || 1));
    const branch = String(args.wtBranch || "").trim();
    return `${providerId}#${index}:${branch}`;
  }

  /**
   * 中文说明：插入或更新单个 worktree 的进度状态，并同步汇总计数。
   */
  private upsertWorktreeState(taskId: string, args: {
    providerId: "codex" | "claude" | "gemini";
    worktreePath: string;
    wtBranch: string;
    index: number;
    status: WorktreeCreateTaskItemStatus;
    error?: string;
    warnings?: string[];
  }): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const key = this.buildWorktreeItemKey({
      worktreePath: args.worktreePath,
      providerId: args.providerId,
      index: args.index,
      wtBranch: args.wtBranch,
    });
    const updatedAt = Date.now();
    const nextItem: WorktreeCreateTaskItemSnapshot = {
      key,
      providerId: args.providerId,
      worktreePath: String(args.worktreePath || "").trim(),
      wtBranch: String(args.wtBranch || "").trim(),
      index: Math.max(1, Math.floor(Number(args.index) || 1)),
      status: args.status,
      updatedAt,
      error: typeof args.error === "string" ? String(args.error || "").trim() || undefined : undefined,
      warnings: Array.isArray(args.warnings) ? args.warnings.map((item) => String(item || "").trim()).filter(Boolean) : undefined,
    };

    const index = task.worktreeStates.findIndex((item) => item.key === key);
    if (index >= 0) {
      task.worktreeStates[index] = { ...task.worktreeStates[index], ...nextItem };
    } else {
      task.worktreeStates.push(nextItem);
    }
    task.worktreeStates.sort((left, right) => {
      const byIndex = left.index - right.index;
      if (byIndex !== 0) return byIndex;
      const byProvider = String(left.providerId || "").localeCompare(String(right.providerId || ""));
      if (byProvider !== 0) return byProvider;
      return String(left.worktreePath || "").localeCompare(String(right.worktreePath || ""));
    });
    this.refreshTaskProgress(taskId);
  }

  /**
   * 中文说明：根据当前条目状态刷新任务级统计（总数/完成数/成功数/失败数/是否全部结束）。
   */
  private refreshTaskProgress(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    let successCount = 0;
    let failedCount = 0;
    for (const item of task.worktreeStates) {
      if (item.status === "success") successCount += 1;
      if (item.status === "error" || item.status === "canceled") failedCount += 1;
    }
    const completed = successCount + failedCount;
    const total = Math.max(0, Math.floor(Number(task.totalCount) || 0));
    const status = task.status;
    const terminal = status === "success" || status === "error" || status === "canceled";

    task.successCount = successCount;
    task.failedCount = failedCount;
    task.completedCount = terminal ? total : Math.min(total, completed);
    task.allCompleted = terminal ? true : total > 0 && task.completedCount >= total;
    task.updatedAt = Date.now();
    task.logSize = task.log.length;
  }

  /**
   * 中文说明：在任务终态时，将尚未结束的条目标记为统一状态，避免 UI 悬停在“创建中”。
   */
  private settleUnfinishedStates(taskId: string, status: "error" | "canceled", fallbackError?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const now = Date.now();
    const next = task.worktreeStates.map((item) => {
      if (item.status === "creating") {
        return {
          ...item,
          status,
          updatedAt: now,
          error: status === "error" ? (item.error || fallbackError || "创建失败") : item.error,
        };
      }
      return item;
    });
    task.worktreeStates = next;
    this.refreshTaskProgress(taskId);
  }

  /**
   * 中文说明：后台执行创建逻辑，并持续写入日志与状态。
   */
  private async runCreateTask(
    taskId: string,
    args: { repoDir: string; baseBranch: string; instances: Array<{ providerId: "codex" | "claude" | "gemini"; count: number }>; gitPath?: string; copyRules?: boolean }
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;

    const repoKey = toFsPathKey(t.repoDir);
    const append = (text: string) => this.appendLog(taskId, text);

    try {
      const res = await createWorktreesAsync({
        repoDir: args.repoDir,
        baseBranch: args.baseBranch,
        instances: args.instances,
        gitPath: args.gitPath,
        copyRules: args.copyRules === true,
        onLog: append,
        signal: t.abortController.signal,
        onItemCreated: (item) => {
          try { t.createdSoFar.push(item); } catch {}
          t.items = [...t.createdSoFar];
          this.upsertWorktreeState(taskId, {
            providerId: item.providerId,
            worktreePath: String(item.worktreePath || "").trim(),
            wtBranch: String(item.wtBranch || "").trim(),
            index: Math.max(1, Math.floor(Number(item.index) || 1)),
            status: "success",
            warnings: Array.isArray(item.warnings) ? item.warnings : undefined,
          });
        },
        onItemFailed: (failed) => {
          this.upsertWorktreeState(taskId, {
            providerId: failed.providerId,
            worktreePath: String(failed.worktreePath || "").trim(),
            wtBranch: String(failed.wtBranch || "").trim(),
            index: Math.max(1, Math.floor(Number(failed.index) || 1)),
            status: "error",
            error: String(failed.error || "").trim() || "创建失败",
          });
        },
        onWorktreePlanned: (p) => {
          const planned = { worktreePath: String(p?.worktreePath || "").trim(), wtBranch: String(p?.wtBranch || "").trim() };
          if (planned.worktreePath) {
            const plannedKey = toFsPathKey(planned.worktreePath) || planned.worktreePath;
            const existed = t.plannedSoFar.some((item) => (toFsPathKey(item.worktreePath) || item.worktreePath) === plannedKey);
            if (!existed) t.plannedSoFar.push(planned);
          }
          this.upsertWorktreeState(taskId, {
            providerId: p.providerId,
            worktreePath: planned.worktreePath,
            wtBranch: planned.wtBranch,
            index: Math.max(1, Math.floor(Number(p.index) || 1)),
            status: "creating",
          });
        },
      });

      if (t.cancelRequested) {
        await this.finishAsCanceledAsync(taskId);
        return;
      }

      if (res && res.ok && Array.isArray(res.items)) {
        t.status = "success";
        t.items = res.items as CreatedWorktree[];
        t.error = undefined;
        this.refreshTaskProgress(taskId);
        append(`\n完成：已创建 ${res.items.length} 个 worktree\n`);
      } else {
        t.status = "error";
        t.error = String(res?.error || "create failed");
        this.settleUnfinishedStates(taskId, "error", t.error);
        append(`\n失败：${t.error}\n`);
      }
    } catch (e: any) {
      if (t.cancelRequested) {
        await this.finishAsCanceledAsync(taskId);
        return;
      }
      t.status = "error";
      t.error = String(e?.message || e);
      this.settleUnfinishedStates(taskId, "error", t.error);
      append(`\n失败：${t.error}\n`);
    } finally {
      t.updatedAt = Date.now();
      t.logSize = t.log.length;
      this.refreshTaskProgress(taskId);
      // 清理 running 映射
      try {
        const cur = this.runningByRepoKey.get(repoKey);
        if (cur === taskId) this.runningByRepoKey.delete(repoKey);
      } catch {}
      this.scheduleCleanup(taskId);
    }
  }

  /**
   * 中文说明：将任务标记为已取消，并执行回滚清理。
   * - 清理内容：worktree 目录、worktree 记录、meta 映射、以及已创建/已尝试创建的 worktree 分支。
   */
  private async finishAsCanceledAsync(taskId: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;

    const append = (text: string) => this.appendLog(taskId, text);
    t.status = "canceling";
    t.items = undefined;
    t.error = undefined;
    t.updatedAt = Date.now();
    this.refreshTaskProgress(taskId);

    const cleanup = await this.cleanupCreatedResourcesAsync({
      repoDir: t.repoDir,
      gitPath: t.gitPath,
      created: t.createdSoFar,
      planned: t.plannedSoFar,
      onLog: append,
    });

    t.status = "canceled";
    t.updatedAt = Date.now();
    t.logSize = t.log.length;
    t.plannedSoFar = [];
    t.createdSoFar = [];
    this.settleUnfinishedStates(taskId, "canceled");

    if (!cleanup.ok) {
      t.error = cleanup.error || "清理失败";
    }
    this.refreshTaskProgress(taskId);
  }

  /**
   * 中文说明：回滚清理已创建/已尝试创建的 worktree 资源（best-effort）。
   */
  private async cleanupCreatedResourcesAsync(args: {
    repoDir: string;
    gitPath?: string;
    created: CreatedWorktree[];
    planned?: Array<{ worktreePath: string; wtBranch: string }>;
    onLog: (text: string) => void;
  }): Promise<{ ok: boolean; error?: string }> {
    const repoDirAbs = toFsPathAbs(args.repoDir);
    const gitPath = args.gitPath;
    const log = (text: string) => {
      try { args.onLog(String(text ?? "")); } catch {}
    };

    /**
     * 中文说明：判断一次 `git worktree remove` 失败是否由 “worktree 被锁定” 导致。
     * - 常见于：取消发生在 `worktree add` 初始化阶段，Git 会留下 lock（lock reason: initializing）。
     */
    const isLockedWorktreeRemoveError = (msg: string): boolean => {
      const text = String(msg || "");
      return /cannot remove a locked working tree|lock reason:/i.test(text);
    };

    /**
     * 中文说明：构建 `git worktree remove` 的 argv，并支持不同强制级别。
     * - forceLevel=0：不加 -f
     * - forceLevel=1：加 -f（--force）
     * - forceLevel=2：加 -f -f（用于覆盖 locked worktree）
     */
    const buildWorktreeRemoveArgv = (worktreePath: string, forceLevel: 0 | 1 | 2): string[] => {
      const wt = String(worktreePath || "").trim();
      const forceArgs = forceLevel <= 0 ? [] : forceLevel === 1 ? ["-f"] : ["-f", "-f"];
      return ["-C", repoDirAbs, "worktree", "remove", ...forceArgs, wt];
    };

    const targets = new Map<string, { worktreePath: string; wtBranch?: string }>();
    for (const it of Array.isArray(args.created) ? args.created : []) {
      const p = String(it?.worktreePath || "").trim();
      if (!p) continue;
      const key = toFsPathKey(p);
      if (!key || targets.has(key)) continue;
      targets.set(key, { worktreePath: p, wtBranch: String(it?.wtBranch || "").trim() || undefined });
    }
    for (const planned of Array.isArray(args.planned) ? args.planned : []) {
      const p = String(planned?.worktreePath || "").trim();
      if (!p) continue;
      const key = toFsPathKey(p);
      if (key && !targets.has(key)) {
        targets.set(key, { worktreePath: p, wtBranch: String(planned?.wtBranch || "").trim() || undefined });
      }
    }

    if (targets.size === 0) {
      log("\n取消完成：本次未创建任何 worktree。\n");
      return { ok: true };
    }

    const failures: string[] = [];
    log(`\n开始清理（共 ${targets.size} 项）…\n`);

    for (const { worktreePath, wtBranch } of targets.values()) {
      const wt = toFsPathAbs(worktreePath);
      log(`\n[清理] worktree: ${wt}\n`);

      // 1) 先尝试移除 worktree 登记（目录可能很大，给更长超时）
      try {
        let rm = await spawnGitAsync({
          gitPath,
          argv: buildWorktreeRemoveArgv(wt, 1),
          timeoutMs: 15 * 60_000,
          onStdout: log,
          onStderr: log,
        });

        // locked worktree：尝试升级到 `-f -f` 强制移除（Git 建议做法）
        if (!rm.ok) {
          const msg1 = String(rm.stderr || rm.error || "").trim();
          if (isLockedWorktreeRemoveError(msg1)) {
            log("[清理] 检测到 worktree 被锁定（可能仍处于初始化），尝试使用 -f -f 强制移除…\n");
            rm = await spawnGitAsync({
              gitPath,
              argv: buildWorktreeRemoveArgv(wt, 2),
              timeoutMs: 15 * 60_000,
              onStdout: log,
              onStderr: log,
            });
          }
        }

        if (!rm.ok) {
          const msg = String(rm.stderr || rm.error || "").trim();
          const ign = /not a working tree|is not a working tree|unknown worktree|not registered|does not exist|already removed|No such file|no such file/i.test(msg);
          if (!ign) failures.push(`worktree remove 失败：${wt}：${msg || "unknown error"}`);
        }
      } catch (e: any) {
        failures.push(`worktree remove 异常：${wt}：${String(e?.message || e)}`);
      }

      // 2) 删除分支（强制；若不存在则忽略）
      if (wtBranch) {
        try {
          const del = await execGitAsync({ gitPath, argv: ["-C", repoDirAbs, "branch", "-D", wtBranch], timeoutMs: 12_000 });
          if (!del.ok) {
            const msg = String(del.stderr || del.error || "").trim();
            const ign = /not found|branch .* not found|不存在|unknown revision|ambiguous argument/i.test(msg);
            if (!ign) failures.push(`删除分支失败：${wtBranch}：${msg || "unknown error"}`);
          }
        } catch (e: any) {
          failures.push(`删除分支异常：${wtBranch}：${String(e?.message || e)}`);
        }
      }

      // 3) 删除 meta（无论是否成功移除 worktree，都应清理）
      try { deleteWorktreeMeta(wt); } catch {}

      // 4) 兜底：强制删除目录（避免残留阻塞后续创建）
      try {
        await fsp.rm(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 } as any);
      } catch (e: any) {
        const msg = String(e?.message || e);
        // 目录不存在不算失败
        if (!/ENOENT|no such file|not found|不存在/i.test(msg)) failures.push(`删除目录失败：${wt}：${msg}`);
      }
    }

    // 5) 兜底：清理 stale worktree 记录（避免“已删目录但仍登记”）
    try {
      await execGitAsync({ gitPath, argv: ["-C", repoDirAbs, "worktree", "prune"], timeoutMs: 60_000 });
    } catch {}

    if (failures.length > 0) {
      const msg = `已取消，但部分清理失败（可能存在文件占用/权限问题）。\n${failures.slice(0, 8).join("\n")}${failures.length > 8 ? `\n…以及另外 ${failures.length - 8} 条` : ""}`;
      log(`\n${msg}\n`);
      return { ok: false, error: msg };
    }

    log("\n取消完成：已清理所有已创建资源。\n");
    return { ok: true };
  }

  /**
   * 中文说明：追加日志并做尾部裁剪（避免极端情况下内存无限增长）。
   */
  private appendLog(taskId: string, text: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const chunk = String(text ?? "");
    if (!chunk) return;
    t.log += chunk;
    if (t.log.length > this.maxLogChars) {
      const overflow = t.log.length - this.maxLogChars;
      const prefix = `[输出过长，已截断前 ${overflow} 字符]\n`;
      t.log = prefix + t.log.slice(overflow);
    }
    t.updatedAt = Date.now();
    t.logSize = t.log.length;
  }

  /**
   * 中文说明：构建对外快照（避免暴露内部可变字段）。
   */
  private snapshot(t: WorktreeCreateTaskState): WorktreeCreateTaskSnapshot {
    return {
      taskId: t.taskId,
      repoDir: t.repoDir,
      baseBranch: t.baseBranch,
      instances: t.instances,
      copyRules: t.copyRules,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      logSize: t.log.length,
      totalCount: t.totalCount,
      completedCount: t.completedCount,
      successCount: t.successCount,
      failedCount: t.failedCount,
      allCompleted: t.allCompleted,
      worktreeStates: Array.isArray(t.worktreeStates) ? [...t.worktreeStates] : [],
      error: t.error,
      items: t.items,
    };
  }

  /**
   * 中文说明：任务完成后延迟清理，避免任务积累导致主进程内存增长。
   */
  private scheduleCleanup(taskId: string): void {
    setTimeout(() => {
      try {
        const t = this.tasks.get(taskId);
        if (!t) return;
        // running 任务不清理
        if (t.status === "running") return;
        this.tasks.delete(taskId);
      } catch {}
    }, this.cleanupTtlMs).unref?.();
  }

  /**
   * 中文说明：生成用于任务的轻量唯一 id。
   */
  private uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
