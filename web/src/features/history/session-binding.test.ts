import { describe, expect, it } from "vitest";

import { findBestHistorySessionForTab, type HistorySessionBindingCandidate } from "./session-binding";

const BASE_TIME = Date.parse("2026-08-06T01:00:00.000Z");

/**
 * 创建去标识化的历史会话测试数据。
 */
function createSession(overrides: Partial<HistorySessionBindingCandidate>): HistorySessionBindingCandidate {
  return {
    id: "session-default",
    providerId: "codex",
    date: new Date(BASE_TIME).toISOString(),
    ...overrides,
  };
}

describe("findBestHistorySessionForTab", () => {
  it("优先使用通知携带的线程 ID 精确匹配", () => {
    const expected = createSession({ id: "summary-id", resumeId: "thread-exact", date: new Date(BASE_TIME - 86_400_000).toISOString() });
    const result = findBestHistorySessionForTab([
      createSession({ id: "nearby", date: new Date(BASE_TIME + 1_000).toISOString() }),
      expected,
    ], {
      providerId: "codex",
      threadId: "THREAD-EXACT",
      tabCreatedAt: BASE_TIME,
    });

    expect(result).toBe(expected);
  });

  it("继续会话保存的绑定 ID 可匹配较旧历史，不受新标签创建时间影响", () => {
    const expected = createSession({
      id: "history-summary",
      resumeId: "resumed-thread",
      date: new Date(BASE_TIME - 7 * 24 * 60 * 60_000).toISOString(),
    });
    const result = findBestHistorySessionForTab([
      createSession({ id: "nearby-new-session", date: new Date(BASE_TIME + 1_000).toISOString() }),
      expected,
    ], {
      providerId: "codex",
      threadId: "resumed-thread",
      tabCreatedAt: BASE_TIME,
    });

    expect(result).toBe(expected);
  });

  it("没有线程 ID 时只在同引擎的相近会话中选择", () => {
    const expected = createSession({ id: "closest", date: new Date(BASE_TIME + 5_000).toISOString() });
    const result = findBestHistorySessionForTab([
      createSession({ id: "wrong-provider", providerId: "claude", date: new Date(BASE_TIME + 100).toISOString() }),
      createSession({ id: "far", date: new Date(BASE_TIME + 60 * 60_000).toISOString() }),
      expected,
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME,
    });

    expect(result).toBe(expected);
  });

  it("没有可信候选时返回空值，避免跳转到错误会话", () => {
    const result = findBestHistorySessionForTab([
      createSession({ id: "old", date: new Date(BASE_TIME - 24 * 60 * 60_000).toISOString() }),
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME,
    });

    expect(result).toBeNull();
  });
});
