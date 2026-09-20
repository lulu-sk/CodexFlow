import { describe, expect, it, vi } from "vitest";
import { createCommitRefreshController } from "./refresh-controller";

describe("commit refresh controller", () => {
  it("并发请求时应串行执行，并把多个请求折叠成最多一个排队任务", async () => {
    const calls: Array<string | undefined> = [];
    const releaseFirstRef: { current: (() => void) | null } = { current: null };
    const firstDone = new Promise<void>((resolve) => {
      releaseFirstRef.current = resolve;
    });
    const runTask = vi.fn(async (options?: { key?: string }) => {
      calls.push(options?.key);
      if (calls.length === 1) await firstDone;
    });
    const controller = createCommitRefreshController(runTask, (_running, pending) => pending);

    const p1 = controller.request({ key: "first" });
    const p2 = controller.request({ key: "second" });
    const p3 = controller.request({ key: "third" });
    expect(runTask).toHaveBeenCalledTimes(1);
    releaseFirstRef.current?.();
    await Promise.all([p1, p2, p3]);

    expect(calls).toEqual(["first", "third"]);
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it("awaitNotBusy 应在最后一轮刷新完成后才返回", async () => {
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createCommitRefreshController(async () => {
      await running;
    }, (_running, pending) => pending);

    const request = controller.request();
    const waiter = controller.awaitNotBusy();
    let resolved = false;
    void waiter.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release();
    await request;
    await waiter;
    expect(resolved).toBe(true);
  });

  it("后续轻量请求不能覆盖已排队的日志刷新和去抖要求", async () => {
    let release!: () => void;
    const firstDone = new Promise<void>((resolve) => { release = resolve; });
    const runTask = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {
      if (runTask.mock.calls.length === 1) await firstDone;
    });
    const controller = createCommitRefreshController(runTask, (current, next) => ({
      keepLog: current?.keepLog !== false && next?.keepLog !== false,
      debounceMs: Math.max(current?.debounceMs || 0, next?.debounceMs || 0),
    }));
    const requests = [
      controller.request({ keepLog: true }),
      controller.request({ keepLog: false, debounceMs: 260 }),
      controller.request({ keepLog: true, debounceMs: 0 }),
    ];
    release();
    await Promise.all(requests);
    expect(runTask).toHaveBeenCalledTimes(2);
    expect(runTask).toHaveBeenLastCalledWith({ keepLog: false, debounceMs: 260 });
  });

  it("没有参数的排队请求也必须在当前刷新结束后执行", async () => {
    let release!: () => void;
    const firstDone = new Promise<void>((resolve) => { release = resolve; });
    const runTask = vi.fn(async () => {
      if (runTask.mock.calls.length === 1) await firstDone;
    });
    const controller = createCommitRefreshController(runTask, (_current, next) => next);
    const first = controller.request();
    const second = controller.request();
    release();
    await Promise.all([first, second]);
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it("刷新失败应通知所有请求且不产生额外未处理异常，之后仍可继续刷新", async () => {
    const failure = new Error("读取失败");
    let reject!: (reason: Error) => void;
    const firstDone = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const runTask = vi.fn(async () => {
      if (runTask.mock.calls.length === 1) await firstDone;
    });
    const controller = createCommitRefreshController(runTask, (_current, next) => next);
    const result = Promise.allSettled([controller.request(), controller.request()]);
    const idle = controller.awaitNotBusy();
    reject(failure);
    expect(await result).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await idle;
    expect(controller.isBusy()).toBe(false);
    await controller.request();
    expect(runTask).toHaveBeenCalledTimes(2);
  });
});
