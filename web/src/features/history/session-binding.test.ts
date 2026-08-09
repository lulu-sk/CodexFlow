import { describe, expect, it } from "vitest";

import {
  bindHistorySessionIdToTabs,
  findBestHistorySessionForTab,
  type HistorySessionBindingCandidate,
} from "./session-binding";

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

  it("通知已提供线程 ID 时不会退化为时间近似匹配", () => {
    const result = findBestHistorySessionForTab([
      createSession({ id: "nearby-other-thread", date: new Date(BASE_TIME + 1_000).toISOString() }),
    ], {
      providerId: "codex",
      threadId: "expected-thread",
      tabCreatedAt: BASE_TIME,
    });

    expect(result).toBeNull();
  });

  it("新一轮开始后会用持续写入的新会话替换过期绑定", () => {
    const expected = createSession({
      id: "active-new-session",
      date: new Date(BASE_TIME + 5_000).toISOString(),
    });
    const result = findBestHistorySessionForTab([
      createSession({ id: "stale-bound-session", date: new Date(BASE_TIME - 1_000).toISOString() }),
      expected,
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME - 60 * 60_000,
      activeTurnStartedAt: BASE_TIME,
      currentSessionId: "stale-bound-session",
    });

    expect(result).toBe(expected);
  });

  it("当前绑定会话在本轮继续写入时保持原绑定", () => {
    const expected = createSession({
      id: "continued-session",
      date: new Date(BASE_TIME + 2_000).toISOString(),
    });
    const result = findBestHistorySessionForTab([
      expected,
      createSession({ id: "other-newer-session", date: new Date(BASE_TIME + 10_000).toISOString() }),
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME - 60 * 60_000,
      activeTurnStartedAt: BASE_TIME,
      currentSessionId: "continued-session",
    });

    expect(result).toBe(expected);
  });

  it("活动会话匹配会排除已被其他标签绑定的会话", () => {
    const expected = createSession({
      id: "available-session",
      date: new Date(BASE_TIME + 3_000).toISOString(),
    });
    const result = findBestHistorySessionForTab([
      createSession({ id: "claimed-session", date: new Date(BASE_TIME + 8_000).toISOString() }),
      expected,
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME - 60 * 60_000,
      activeTurnStartedAt: BASE_TIME,
      excludedSessionIds: ["claimed-session"],
    });

    expect(result).toBe(expected);
  });

  it("新一轮没有近期活动候选时不覆盖已有绑定", () => {
    const result = findBestHistorySessionForTab([
      createSession({ id: "stale-bound-session", date: new Date(BASE_TIME - 10 * 60_000).toISOString() }),
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME - 60 * 60_000,
      activeTurnStartedAt: BASE_TIME,
      currentSessionId: "stale-bound-session",
    });

    expect(result).toBeNull();
  });

  it("精确线程 ID 在活动会话发现期间仍保持最高优先级", () => {
    const expected = createSession({
      id: "exact-session",
      resumeId: "exact-thread",
      date: new Date(BASE_TIME - 24 * 60 * 60_000).toISOString(),
    });
    const result = findBestHistorySessionForTab([
      createSession({ id: "active-nearby-session", date: new Date(BASE_TIME + 5_000).toISOString() }),
      expected,
    ], {
      providerId: "codex",
      threadId: "exact-thread",
      tabCreatedAt: BASE_TIME - 60 * 60_000,
      activeTurnStartedAt: BASE_TIME,
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

describe("bindHistorySessionIdToTabs", () => {
  it("把首次回复携带的会话 ID 写回目标标签", () => {
    const source = {
      "project-a": [{ id: "tab-a", historySessionId: undefined }],
      "project-b": [{ id: "tab-b", historySessionId: undefined }],
    };

    const result = bindHistorySessionIdToTabs(source, "tab-b", "thread-b", "project-a");

    expect(result.changed).toBe(true);
    expect(result.projectId).toBe("project-b");
    expect(result.tabsByProject["project-b"][0].historySessionId).toBe("thread-b");
    expect(result.tabsByProject["project-a"]).toBe(source["project-a"]);
  });

  it("重复绑定同一会话时保持原状态引用", () => {
    const source = {
      "project-a": [{ id: "tab-a", historySessionId: "thread-a" }],
    };

    const result = bindHistorySessionIdToTabs(source, "tab-a", "THREAD-A", "project-a");

    expect(result.changed).toBe(false);
    expect(result.tabsByProject).toBe(source);
  });
});
