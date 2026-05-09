// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  __testing as changeListTesting,
  acquireChangeListHostQueueSlotAsync,
  ChangeListManagerEx,
  resolveChangeListHostId,
  subscribeChangeListHost,
  waitForChangeListHostReadyAsync,
} from "../changelists";

type VcsFreezingHostListener = {
  onFreeze?(): void;
  onUnfreeze?(): void;
};

type VcsFreezingProcessRuntime = {
  hostId?: string;
  userDataPath?: string;
  repoRoot?: string;
  emitProgress?(message: string, detail?: string): void;
};

/**
 * 为冻结流程解析统一 host id；优先复用显式 hostId，其次按 changelist 平台的工作区规则推导。
 */
function resolveFreezingHostId(runtime: VcsFreezingProcessRuntime): string {
  const explicitHostId = String(runtime.hostId || "").trim();
  if (explicitHostId) return explicitHostId;
  return resolveChangeListHostId(runtime.userDataPath || "", runtime.repoRoot);
}

/**
 * 为冻结流程创建 changelist 平台管理器，使 freeze/unfreeze/block/wait 全部落到同一套平台状态。
 */
function createChangeListManager(runtime: VcsFreezingProcessRuntime, hostId: string): ChangeListManagerEx {
  const userDataPath = String(runtime.userDataPath || runtime.hostId || hostId).trim() || hostId;
  const repoRoot = String(runtime.repoRoot || runtime.hostId || hostId).trim() || hostId;
  return new ChangeListManagerEx({
    userDataPath,
    repoRoot,
  });
}

/**
 * 等待宿主退出冻结态，供外部自动刷新或后台更新任务显式避让。
 */
export async function waitForVcsUnfreezeAsync(hostId: string): Promise<void> {
  await waitForChangeListHostReadyAsync(hostId);
}

/**
 * 订阅宿主级冻结事件，底层直接复用 changelist 平台状态广播。
 */
export function subscribeVcsFreezingHost(hostId: string, listener: VcsFreezingHostListener): () => void {
  return subscribeChangeListHost(hostId, listener);
}

/**
 * 执行一次宿主级冻结流程，对齐 IDEA `VcsFreezingProcess` 的 save/block/freeze/unfreeze/unblock 顺序。
 */
export async function runVcsFreezingAsync<T>(
  runtime: VcsFreezingProcessRuntime,
  operationTitle: string,
  action: () => Promise<T>,
): Promise<T> {
  const hostId = resolveFreezingHostId(runtime);
  const changeListManager = createChangeListManager(runtime, hostId);
  const releaseQueue = await acquireChangeListHostQueueSlotAsync(hostId);
  changeListManager.blockModalNotifications();
  runtime.emitProgress?.("正在保存文档并阻断自动同步", operationTitle);
  try {
    await changeListManager.promiseWaitForUpdate();
    changeListManager.freeze(operationTitle);
    runtime.emitProgress?.("正在冻结本地改动视图", operationTitle);
    try {
      return await action();
    } finally {
      changeListManager.unfreeze();
      runtime.emitProgress?.("已解除本地改动冻结", operationTitle);
    }
  } finally {
    changeListManager.unblockModalNotifications();
    releaseQueue();
    runtime.emitProgress?.("已恢复自动同步", operationTitle);
  }
}

/**
 * 对齐 IDEA `VcsFreezingProcess` 的轻量执行器。
 */
export class VcsFreezingProcess<T> {
  private readonly runtime: VcsFreezingProcessRuntime;

  private readonly operationTitle: string;

  private readonly action: () => Promise<T>;

  /**
   * 初始化一次宿主冻结执行器。
   */
  constructor(runtime: VcsFreezingProcessRuntime, operationTitle: string, action: () => Promise<T>) {
    this.runtime = runtime;
    this.operationTitle = String(operationTitle || "").trim() || "vcs operation";
    this.action = action;
  }

  /**
   * 执行完整的宿主冻结流程。
   */
  async execute(): Promise<T> {
    return await runVcsFreezingAsync(this.runtime, this.operationTitle, this.action);
  }
}

/**
 * 暴露测试辅助方法，便于验证宿主阻断语义而不依赖 changelist 平台内部细节。
 */
export const __testing = {
  /**
   * 读取指定宿主当前的冻结状态快照。
   */
  getHostState(hostId: string): { blocked: number; frozen: number; reason?: string } {
    const state = changeListTesting.getHostState(hostId);
    return {
      blocked: state.blockedModalNotifications,
      frozen: state.freezeDepth,
      reason: state.freezeReason,
    };
  },

  /**
   * 清空全部宿主状态，供单测在每个用例后隔离环境。
   */
  resetAllHosts(): void {
    changeListTesting.resetAllHosts();
  },
};
