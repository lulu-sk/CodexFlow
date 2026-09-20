// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useCallback, useRef } from "react";

export type CommitRefreshRequest<TOptions> = {
  options?: TOptions;
  resolve(): void;
  reject(error: unknown): void;
};

type CommitRefreshWaiter = {
  resolve(): void;
};

/**
 * 返回稳定的异步调用入口；生命周期 effect 可以依赖它而不因真实回调重建被误判成需要再次触发。
 */
export function useLatestAsyncRunner<TArgs extends unknown[]>(
  runner: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  return useCallback(async (...args: TArgs): Promise<void> => {
    await runnerRef.current(...args);
  }, []);
}

/**
 * 创建等价 SingleTaskRunner 的刷新控制器；同一时刻只允许一个运行中刷新和一个待执行刷新。
 */
export function createCommitRefreshController<TOptions>(
  runTask: (options?: TOptions) => Promise<void>,
  mergeOptions: (running: TOptions | undefined, pending: TOptions | undefined) => TOptions | undefined,
): {
  request(options?: TOptions): Promise<void>;
  isBusy(): boolean;
  awaitNotBusy(): Promise<void>;
} {
  let busy = false;
  let runningOptions: TOptions | undefined;
  let pendingOptions: TOptions | undefined;
  let hasPendingRequest = false;
  let waiters: CommitRefreshRequest<TOptions>[] = [];
  let notBusyWaiters: CommitRefreshWaiter[] = [];

  /** 通知本轮所有请求；显式区分成功与失败，保留空值异常的拒绝语义。 */
  const flushWaiters = (failed = false, error?: unknown): void => {
    const current = waiters;
    waiters = [];
    for (const waiter of current) {
      if (failed) waiter.reject(error);
      else waiter.resolve();
    }
  };

  /**
   * 在刷新循环完全结束后统一唤醒 `awaitNotBusy()` 等待者，保证 callback 不会抢在最后一轮状态提交前执行。
   */
  const flushNotBusyWaiters = (): void => {
    const current = notBusyWaiters;
    notBusyWaiters = [];
    for (const waiter of current)
      waiter.resolve();
  };

  /** 串行消费合并后的请求，任务异常只通过请求本身返回，避免悬空的拒绝。 */
  const runLoop = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (hasPendingRequest) {
        runningOptions = pendingOptions;
        pendingOptions = undefined;
        hasPendingRequest = false;
        await runTask(runningOptions);
      }
      flushWaiters();
    } catch (error) {
      flushWaiters(true, error);
    } finally {
      runningOptions = undefined;
      pendingOptions = undefined;
      hasPendingRequest = false;
      busy = false;
      queueMicrotask(() => {
        if (!busy && waiters.length === 0)
          flushNotBusyWaiters();
      });
    }
  };

  return {
    request(options?: TOptions): Promise<void> {
      // 后续请求必须累积已有排队要求，不能用运行中的旧选项覆盖它们。
      pendingOptions = mergeOptions(hasPendingRequest ? pendingOptions : runningOptions, options);
      hasPendingRequest = true;
      return new Promise<void>((resolve, reject) => {
        waiters.push({ options, resolve, reject });
        void runLoop();
      });
    },
    isBusy(): boolean {
      return busy;
    },
    awaitNotBusy(): Promise<void> {
      if (!busy && waiters.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        notBusyWaiters.push({ resolve });
      });
    },
  };
}
