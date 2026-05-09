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
  let waiters: CommitRefreshRequest<TOptions>[] = [];
  let notBusyWaiters: CommitRefreshWaiter[] = [];

  const flushWaiters = (error?: unknown): void => {
    const current = waiters;
    waiters = [];
    for (const waiter of current) {
      if (error) waiter.reject(error);
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

  const runLoop = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (waiters.length > 0) {
        runningOptions = pendingOptions;
        pendingOptions = undefined;
        await runTask(runningOptions);
        if (!pendingOptions) break;
      }
      flushWaiters();
    } catch (error) {
      flushWaiters(error);
      throw error;
    } finally {
      runningOptions = undefined;
      pendingOptions = undefined;
      busy = false;
      queueMicrotask(() => {
        if (!busy && waiters.length === 0)
          flushNotBusyWaiters();
      });
    }
  };

  return {
    request(options?: TOptions): Promise<void> {
      pendingOptions = mergeOptions(runningOptions, options);
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
