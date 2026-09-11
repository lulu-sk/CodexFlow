import { describe, expect, it } from "vitest";

import {
  bindHistorySessionIdToTabs,
  findBestHistorySessionForTab,
  shouldWaitForHistorySessionBinding,
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

  it("新一轮开始后会用唯一正在写入的新会话替换过期绑定", () => {
    const expected = createSession({
      id: "active-new-session",
      date: new Date(BASE_TIME + 5_000).toISOString(),
    });
    const result = findBestHistorySessionForTab([
      createSession({ id: "bound-session", date: new Date(BASE_TIME - 1_000).toISOString() }),
      expected,
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME - 60 * 60_000,
      activeTurnStartedAt: BASE_TIME,
      currentSessionId: "bound-session",
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

  it("新一轮文件尚未刷新时仍可查看已有会话", () => {
    const expected = createSession({ id: "bound-session", date: new Date(BASE_TIME - 10 * 60_000).toISOString() });
    const result = findBestHistorySessionForTab([
      expected,
    ], {
      providerId: "codex",
      tabCreatedAt: BASE_TIME - 60 * 60_000,
      activeTurnStartedAt: BASE_TIME,
      currentSessionId: "bound-session",
    });

    expect(result).toBe(expected);
  });

  it("新会话的精确通知可以替换旧绑定", () => {
    const expected = createSession({ id: "new-session" });
    expect(findBestHistorySessionForTab([createSession({ id: "old-session" }), expected], {
      providerId: "codex", threadId: "new-session", currentSessionId: "old-session",
      tabCreatedAt: BASE_TIME, activeTurnStartedAt: BASE_TIME,
    })).toBe(expected);
  });

  it("先显示尚未刷新的旧绑定，晚到的新会话仍能接管", () => {
    const previous = createSession({ id: "previous", date: new Date(BASE_TIME - 60_000).toISOString() });
    const next = createSession({ id: "next", date: new Date(BASE_TIME + 1_000).toISOString() });
    const context = { providerId: "codex", currentSessionId: "previous", tabCreatedAt: BASE_TIME - 60_000, activeTurnStartedAt: BASE_TIME };

    expect(findBestHistorySessionForTab([previous], context)).toBe(previous);
    expect(findBestHistorySessionForTab([previous, next], context)).toBe(next);
  });

  it("文件更新时间略早于计时起点时仍能发现当前会话", () => {
    const expected = createSession({ date: new Date(BASE_TIME - 500).toISOString() });
    expect(findBestHistorySessionForTab([expected], {
      providerId: "codex", tabCreatedAt: BASE_TIME - 60 * 60_000, activeTurnStartedAt: BASE_TIME,
    })).toBe(expected);
  });

  it("多个未绑定终端同时写入时不按最新时间猜测", () => {
    expect(findBestHistorySessionForTab([
      createSession({ id: "session-a", date: new Date(BASE_TIME + 1_000).toISOString() }),
      createSession({ id: "session-b", date: new Date(BASE_TIME + 2_000).toISOString() }),
    ], { providerId: "codex", tabCreatedAt: BASE_TIME, activeTurnStartedAt: BASE_TIME })).toBeNull();
  });

  it("按创建时间兜底也排除其他标签和子代理的历史", () => {
    const expected = createSession({ id: "main-session", date: new Date(BASE_TIME + 3_000).toISOString() });
    expect(findBestHistorySessionForTab([
      createSession({ id: "claimed-session" }),
      createSession({ id: "child-session", codexRelationship: { kind: "subagent" } }),
      expected,
    ], { providerId: "codex", tabCreatedAt: BASE_TIME, excludedSessionIds: ["claimed-session"] })).toBe(expected);
  });

  it.each(["codex", "claude", "gemini", "grok", "antigravity"])("%s 使用恢复编号精确定位旧历史", (providerId) => {
    const expected = createSession({ providerId, id: "summary", resumeId: "session-id" });
    expect(findBestHistorySessionForTab([expected], {
      providerId, threadId: "SESSION-ID", tabCreatedAt: BASE_TIME + 86_400_000,
    })).toBe(expected);
  });

  it("文件名编号匹配不受父目录中其他 UUID 干扰", () => {
    const expected = createSession({ filePath: "/history/11111111-1111-1111-1111-111111111111/rollout-22222222-2222-2222-2222-222222222222.jsonl" });
    expect(findBestHistorySessionForTab([expected], {
      providerId: "codex", threadId: "22222222-2222-2222-2222-222222222222", tabCreatedAt: BASE_TIME,
    })).toBe(expected);
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

describe("shouldWaitForHistorySessionBinding", () => {
  it("已有绑定 ID 或存在活动会话发现时继续等待", () => {
    expect(shouldWaitForHistorySessionBinding("thread-a", undefined)).toBe(true);
    expect(shouldWaitForHistorySessionBinding("", BASE_TIME)).toBe(true);
  });

  it("没有绑定和活动会话时允许显示未找到", () => {
    expect(shouldWaitForHistorySessionBinding("", 0)).toBe(false);
    expect(shouldWaitForHistorySessionBinding(undefined, Number.NaN)).toBe(false);
  });
});
