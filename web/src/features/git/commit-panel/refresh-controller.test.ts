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
});
