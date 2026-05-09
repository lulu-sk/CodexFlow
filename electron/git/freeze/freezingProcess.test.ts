import { afterEach, describe, expect, it } from "vitest";
import { __testing, GitFreezingProcess, subscribeVcsFreezingHost, waitForVcsUnfreezeAsync } from "./freezingProcess";

/**
 * 创建一个带可观察顺序记录的冻结任务。
 */
function createFreezingTask(order: string[], name: string, delayMs: number): GitFreezingProcess<void> {
  return new GitFreezingProcess(
    {
      repoRoot: "/repo",
    },
    name,
    async () => {
      order.push(`${name}:start`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      order.push(`${name}:end`);
    },
  );
}

describe("git freezing process", () => {
  afterEach(() => {
    __testing.resetAllHosts();
  });

  it("同一仓库的冻结区段应串行执行", async () => {
    const order: string[] = [];
    const first = createFreezingTask(order, "first", 30);
    const second = createFreezingTask(order, "second", 0);

    await Promise.all([first.execute(), second.execute()]);

    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("同一宿主下应先阻断后续观察者，直到 unfreeze 后才继续", async () => {
    const events: string[] = [];
    const runtime = {
      repoRoot: "/repo/a",
      userDataPath: "/workspace/user-data",
    };
    const unsubscribe = subscribeVcsFreezingHost("/workspace/user-data", {
      onFreeze() {
        events.push("freeze");
      },
      onUnfreeze() {
        events.push("unfreeze");
      },
    });
    try {
      const task = new GitFreezingProcess(runtime, "host-blocking", async () => {
        events.push("task:start");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
        events.push("task:end");
      });

      const running = task.execute();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      events.push("wait:start");
      await waitForVcsUnfreezeAsync("/workspace/user-data");
      events.push("wait:end");
      await running;

      expect(events).toEqual([
        "freeze",
        "task:start",
        "wait:start",
        "task:end",
        "unfreeze",
        "wait:end",
      ]);
    } finally {
      unsubscribe();
    }
  });
});
