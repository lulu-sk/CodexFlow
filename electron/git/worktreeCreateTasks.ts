// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { toFsPathKey } from "./pathKey";
import { createWorktreesAsync, type CreatedWorktree } from "./worktreeOps";

export type WorktreeCreateTaskStatus = "running" | "success" | "error";

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
  error?: string;
  items?: CreatedWorktree[];
};

type WorktreeCreateTaskState = WorktreeCreateTaskSnapshot & {
  log: string;
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
      if (existing && existing.status === "running") {
        return { ok: true, taskId: existingTaskId, reused: true };
      }
      // 异常兜底：清理脏映射
      try { this.runningByRepoKey.delete(repoKey); } catch {}
    }

    const taskId = this.uid();
    const now = Date.now();
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
      log: "",
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
      });
      if (res && res.ok && Array.isArray(res.items)) {
        t.status = "success";
        t.items = res.items as CreatedWorktree[];
        t.error = undefined;
        append(`\n完成：已创建 ${res.items.length} 个 worktree\n`);
      } else {
        t.status = "error";
        t.items = undefined;
        t.error = String(res?.error || "create failed");
        append(`\n失败：${t.error}\n`);
      }
    } catch (e: any) {
      t.status = "error";
      t.items = undefined;
      t.error = String(e?.message || e);
      append(`\n失败：${t.error}\n`);
    } finally {
      t.updatedAt = Date.now();
      t.logSize = t.log.length;
      // 清理 running 映射
      try {
        const cur = this.runningByRepoKey.get(repoKey);
        if (cur === taskId) this.runningByRepoKey.delete(repoKey);
      } catch {}
      this.scheduleCleanup(taskId);
    }
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
