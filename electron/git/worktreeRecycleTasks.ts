// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { recycleWorktreeAsync, type RecycleWorktreeResult } from "./worktreeOps";
import { getWorktreeMeta } from "../stores/worktreeMetaStore";

export type WorktreeRecycleTaskStatus = "running" | "success" | "error";

export type WorktreeRecycleTaskSnapshot = {
  taskId: string;
  worktreePath: string;
  repoMainPath: string;
  baseBranch: string;
  wtBranch: string;
  /** 回收范围：默认仅回收分叉点之后的提交；可选完整回收。 */
  range: "since_fork" | "full";
  /** 可选：手动指定的分叉点引用（提交号/引用），仅在 range=since_fork 时生效。 */
  forkBaseRef?: string;
  mode: "squash" | "rebase";
  autoStashBaseWorktree: boolean;
  status: WorktreeRecycleTaskStatus;
  createdAt: number;
  updatedAt: number;
  /** 当前已累计日志字符数（用于增量拉取）。 */
  logSize: number;
  error?: string;
  result?: RecycleWorktreeResult;
};

type WorktreeRecycleTaskState = WorktreeRecycleTaskSnapshot & {
  log: string;
};

/**
 * 中文说明：管理 worktree 回收后台任务（可查询进度与输出日志）。
 *
 * 设计目标：
 * - 回收过程中可展示实时日志（包含 git 输出）
 * - UI 可关闭弹窗；任务继续在主进程后台执行
 * - 可通过 taskId 增量拉取日志与最终结果
 */
export class WorktreeRecycleTaskManager {
  private readonly tasks = new Map<string, WorktreeRecycleTaskState>();
  private readonly runningByKey = new Map<string, string>();
  private readonly maxLogChars: number;
  private readonly cleanupTtlMs: number;

  constructor(args?: { maxLogChars?: number; cleanupTtlMs?: number }) {
    this.maxLogChars = Math.max(32_000, Math.min(50 * 1024 * 1024, Math.floor(Number(args?.maxLogChars ?? 4 * 1024 * 1024))));
    this.cleanupTtlMs = Math.max(10_000, Math.min(6 * 60 * 60_000, Math.floor(Number(args?.cleanupTtlMs ?? 30 * 60_000))));
  }

  /**
   * 启动（或复用）指定 worktree 的回收任务。
   */
  public startOrReuse(args: {
    worktreePath: string;
    baseBranch: string;
    wtBranch: string;
    range?: "since_fork" | "full";
    forkBaseRef?: string;
    mode: "squash" | "rebase";
    gitPath?: string;
    commitMessage?: string;
    autoStashBaseWorktree?: boolean;
  }): { ok: boolean; taskId?: string; reused?: boolean; error?: string } {
    const worktreePath = String(args?.worktreePath || "").trim();
    const baseBranch = String(args?.baseBranch || "").trim();
    const wtBranch = String(args?.wtBranch || "").trim();
    const range = args?.range === "full" ? "full" : "since_fork";
    const forkBaseRef = typeof args?.forkBaseRef === "string" ? String(args.forkBaseRef).trim() : "";
    const mode = args?.mode;
    if (!worktreePath) return { ok: false, error: "missing worktreePath" };
    if (!baseBranch) return { ok: false, error: "missing baseBranch" };
    if (!wtBranch) return { ok: false, error: "missing wtBranch" };
    if (mode !== "squash" && mode !== "rebase") return { ok: false, error: "invalid mode" };

    const key = toFsPathKey(worktreePath) || worktreePath;
    const existingTaskId = this.runningByKey.get(key);
    if (existingTaskId) {
      const existing = this.tasks.get(existingTaskId);
      if (existing && existing.status === "running") {
        return { ok: true, taskId: existingTaskId, reused: true };
      }
      try { this.runningByKey.delete(key); } catch {}
    }

    const taskId = this.uid();
    const now = Date.now();
    const meta = getWorktreeMeta(worktreePath);
    const repoMainPath = toFsPathAbs(String(meta?.repoMainPath || worktreePath));

    const state: WorktreeRecycleTaskState = {
      taskId,
      worktreePath: toFsPathAbs(worktreePath),
      repoMainPath,
      baseBranch,
      wtBranch,
      range,
      forkBaseRef: forkBaseRef || undefined,
      mode,
      autoStashBaseWorktree: args?.autoStashBaseWorktree === true,
      status: "running",
      createdAt: now,
      updatedAt: now,
      logSize: 0,
      log: "",
      error: undefined,
      result: undefined,
    };
    this.tasks.set(taskId, state);
    this.runningByKey.set(key, taskId);

    // 后台执行：不阻塞 IPC 回包
    void this.runRecycleTask(taskId, { ...args, worktreePath, baseBranch, wtBranch, range, forkBaseRef: forkBaseRef || undefined, mode }).catch(() => {});
    return { ok: true, taskId, reused: false };
  }

  /**
   * 获取任务快照，并按 from 偏移增量返回日志 append。
   */
  public get(args: { taskId: string; from?: number }): { ok: boolean; task?: WorktreeRecycleTaskSnapshot; append?: string; error?: string } {
    const taskId = String(args?.taskId || "").trim();
    if (!taskId) return { ok: false, error: "missing taskId" };
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "task not found" };
    const from = Math.max(0, Math.min(Number.isFinite(Number(args?.from)) ? Math.floor(Number(args?.from)) : 0, t.log.length));
    const append = from >= t.log.length ? "" : t.log.slice(from);
    return { ok: true, task: this.snapshot(t), append };
  }

  /**
   * 中文说明：后台执行回收逻辑，并持续写入日志与最终结果。
   */
  private async runRecycleTask(
    taskId: string,
    args: {
      worktreePath: string;
      baseBranch: string;
      wtBranch: string;
      range: "since_fork" | "full";
      forkBaseRef?: string;
      mode: "squash" | "rebase";
      gitPath?: string;
      commitMessage?: string;
      autoStashBaseWorktree?: boolean;
    }
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;

    const key = toFsPathKey(args.worktreePath) || args.worktreePath;
    const append = (text: string) => this.appendLog(taskId, text);

    try {
      append(`启动回收任务：${taskId}\n\n`);
      const res = await recycleWorktreeAsync({
        worktreePath: args.worktreePath,
        baseBranch: args.baseBranch,
        wtBranch: args.wtBranch,
        range: args.range,
        forkBaseRef: args.forkBaseRef,
        mode: args.mode,
        gitPath: args.gitPath,
        commitMessage: args.commitMessage,
        autoStashBaseWorktree: args.autoStashBaseWorktree === true,
        onLog: append,
      });
      t.result = res as RecycleWorktreeResult;
      if (res && (res as any).ok === true) {
        t.status = "success";
        t.error = undefined;
        append("\n完成：回收已结束\n");
      } else {
        t.status = "error";
        const code = String((res as any)?.errorCode || "").trim();
        const hint = String((res as any)?.details?.error || (res as any)?.details?.stderr || "").trim();
        t.error = hint || code || "recycle failed";
        append(`\n失败：${t.error}\n`);
      }
    } catch (e: any) {
      t.status = "error";
      t.result = undefined;
      t.error = String(e?.message || e);
      append(`\n失败：${t.error}\n`);
    } finally {
      t.updatedAt = Date.now();
      t.logSize = t.log.length;
      try {
        const cur = this.runningByKey.get(key);
        if (cur === taskId) this.runningByKey.delete(key);
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
  private snapshot(t: WorktreeRecycleTaskState): WorktreeRecycleTaskSnapshot {
    return {
      taskId: t.taskId,
      worktreePath: t.worktreePath,
      repoMainPath: t.repoMainPath,
      baseBranch: t.baseBranch,
      wtBranch: t.wtBranch,
      range: t.range,
      forkBaseRef: t.forkBaseRef,
      mode: t.mode,
      autoStashBaseWorktree: t.autoStashBaseWorktree,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      logSize: t.log.length,
      error: t.error,
      result: t.result,
    };
  }

  /**
   * 中文说明：任务结束后延迟清理，避免任务积累导致主进程内存增长。
   */
  private scheduleCleanup(taskId: string): void {
    setTimeout(() => {
      try {
        const t = this.tasks.get(taskId);
        if (!t) return;
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

