// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  __testing as vcsFreezingTesting,
  subscribeVcsFreezingHost,
  VcsFreezingProcess,
  waitForVcsUnfreezeAsync,
} from "./vcsFreezingProcess";

type GitFreezingRuntime = {
  repoRoot: string;
  ctx?: {
    userDataPath?: string;
  };
  userDataPath?: string;
  emitProgress?(message: string, detail?: string): void;
};

/**
 * 为 Git 冻结流程解析宿主 id；优先按工作区 `userDataPath` 聚合，缺失时退化到仓库路径。
 */
function resolveFreezingHostId(runtime: GitFreezingRuntime): string {
  return String(runtime.userDataPath || runtime.ctx?.userDataPath || runtime.repoRoot || "").trim() || "__default__";
}

/**
 * 为 Git 冻结流程补上与 IDEA 一致的“Git 操作”宿主文案前缀。
 */
function buildGitOperationTitle(operationTitle: string): string {
  const normalized = String(operationTitle || "").trim() || "git operation";
  return `Git 操作：${normalized}`;
}

/**
 * 运行一个“冻结本地改动视图”的 Git 区段，底层复用宿主级 `VcsFreezingProcess`。
 */
export async function runGitFreezingAsync<T>(
  runtime: GitFreezingRuntime,
  operationTitle: string,
  action: () => Promise<T>,
): Promise<T> {
  const process = new VcsFreezingProcess<T>({
    hostId: resolveFreezingHostId(runtime),
    userDataPath: String(runtime.userDataPath || runtime.ctx?.userDataPath || "").trim() || undefined,
    repoRoot: String(runtime.repoRoot || "").trim() || undefined,
    emitProgress: runtime.emitProgress,
  }, buildGitOperationTitle(operationTitle), action);
  return await process.execute();
}

/**
 * 对齐 IDEA `GitFreezingProcess` 的 Git 层封装。
 */
export class GitFreezingProcess<T> {
  private readonly runtime: GitFreezingRuntime;

  private readonly operationTitle: string;

  private readonly action: () => Promise<T>;

  /**
   * 初始化 Git 冻结执行器。
   */
  constructor(runtime: GitFreezingRuntime, operationTitle: string, action: () => Promise<T>) {
    this.runtime = runtime;
    this.operationTitle = String(operationTitle || "").trim() || "git operation";
    this.action = action;
  }

  /**
   * 执行完整的 Git 冻结流程。
   */
  async execute(): Promise<T> {
    return await runGitFreezingAsync(this.runtime, this.operationTitle, this.action);
  }
}

export {
  VcsFreezingProcess,
  subscribeVcsFreezingHost,
  waitForVcsUnfreezeAsync,
};

/**
 * 导出测试辅助对象，便于验证宿主冻结状态。
 */
export const __testing = vcsFreezingTesting;
