import { describe, expect, it } from "vitest";

import {
  collectRetainedAgentTurnTabIds,
  pruneAgentTurnHistory,
  pruneAgentTurnTimers,
} from "./agent-turn-timer";

type MockTimerState = {
  status: "working" | "done" | "interrupted";
  startedAt: number;
  elapsedMs: number;
};

/**
 * 中文说明：创建一个最小计时状态，避免测试样例重复样板代码。
 */
function createTimerState(status: MockTimerState["status"]): MockTimerState {
  return {
    status,
    startedAt: 1,
    elapsedMs: 2,
  };
}

describe("agent-turn-timer（计时状态清理）", () => {
  it("保留已同步的内置会话计时", () => {
    const result = pruneAgentTurnTimers({
      timerByTab: { "tab-1": createTimerState("working") },
      tabsByProject: {
        wt1: [{ id: "tab-1", providerId: "codex" }],
      },
      shouldEnableTimerForProvider: (providerId) => providerId === "codex",
    });

    expect(result.changed).toBe(false);
    expect(result.nextTimerByTab).toEqual({
      "tab-1": createTimerState("working"),
    });
  });

  it("移除已经失效的标签页计时与历史", () => {
    const timerResult = pruneAgentTurnTimers({
      timerByTab: {
        stale: createTimerState("working"),
      },
      tabsByProject: {},
      shouldEnableTimerForProvider: () => true,
    });
    const historyResult = pruneAgentTurnHistory({
      historyByTab: {
        stale: [createTimerState("done")],
      },
      tabsByProject: {},
    });

    expect(timerResult.changed).toBe(true);
    expect(timerResult.nextTimerByTab).toEqual({});
    expect(historyResult.changed).toBe(true);
    expect(historyResult.nextHistoryByTab).toEqual({});
  });

  it("保留尚未同步到 tabsByProject 的新建标签页计时与历史", () => {
    const timerResult = pruneAgentTurnTimers({
      timerByTab: {
        fresh: createTimerState("working"),
      },
      tabsByProject: {},
      retainedTabIds: ["fresh"],
      shouldEnableTimerForProvider: () => true,
    });
    const historyResult = pruneAgentTurnHistory({
      historyByTab: {
        fresh: [createTimerState("done")],
      },
      tabsByProject: {},
      retainedTabIds: ["fresh"],
    });

    expect(timerResult.changed).toBe(false);
    expect(timerResult.nextTimerByTab).toEqual({
      fresh: createTimerState("working"),
    });
    expect(historyResult.changed).toBe(false);
    expect(historyResult.nextHistoryByTab).toEqual({
      fresh: [createTimerState("done")],
    });
  });

  it("仅保留仍有运行时绑定的未同步标签页", () => {
    const retained = collectRetainedAgentTurnTabIds({
      tabsByProject: {
        project: [{ id: "synced", providerId: "codex" }],
      },
      registeredTabIds: ["synced", "fresh", "stale"],
      hasLiveUnsyncedTab: (tabId) => tabId === "fresh",
    });

    expect(retained).toEqual(["fresh"]);
  });

  it("已同步但不支持计时的标签页会移除计时，同时保留历史", () => {
    const timerResult = pruneAgentTurnTimers({
      timerByTab: {
        shell: createTimerState("working"),
      },
      tabsByProject: {
        project: [{ id: "shell", providerId: "terminal" }],
      },
      shouldEnableTimerForProvider: (providerId) => providerId === "codex",
    });
    const historyResult = pruneAgentTurnHistory({
      historyByTab: {
        shell: [createTimerState("done")],
      },
      tabsByProject: {
        project: [{ id: "shell", providerId: "terminal" }],
      },
    });

    expect(timerResult.changed).toBe(true);
    expect(timerResult.nextTimerByTab).toEqual({});
    expect(historyResult.changed).toBe(false);
    expect(historyResult.nextHistoryByTab).toEqual({
      shell: [createTimerState("done")],
    });
  });
});
