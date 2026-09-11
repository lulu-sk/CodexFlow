import { describe, expect, it, vi } from "vitest";
import { findBestHistorySessionForTab, type HistorySessionBindingCandidate } from "./session-binding";
import { lookupHistoryWithStableContext } from "./session-lookup";

describe("lookupHistoryWithStableContext", () => {
  it("首次查询期间通知补上会话编号，一次操作就重查并打开旧历史", async () => {
    let context = { signature: "unbound", threadId: "" };
    const expected: HistorySessionBindingCandidate = { id: "summary", resumeId: "session", providerId: "codex", date: "2026-01-01T00:00:00Z" };
    const load = vi.fn(async () => {
      if (!context.threadId) {
        context = { signature: "bound", threadId: "session" };
        return [];
      }
      return [expected];
    });
    const resolve = vi.fn((current, sessions: HistorySessionBindingCandidate[]) => findBestHistorySessionForTab(sessions, {
      providerId: "codex", threadId: current.threadId, tabCreatedAt: Date.parse("2026-02-01T00:00:00Z"),
    }));

    const result = await lookupHistoryWithStableContext({ getContext: () => context, load, resolve });

    expect(result).toBe(expected);
    expect(load).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("标签关闭后不应用已返回的旧请求", async () => {
    let context: { signature: string } | null = { signature: "tab" };
    const resolve = vi.fn();
    const result = await lookupHistoryWithStableContext({
      getContext: () => context,
      load: async () => { context = null; return ["old"]; },
      resolve,
    });
    expect(result).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("相同上下文的空结果不立即重复请求", async () => {
    const load = vi.fn(async () => []);
    expect(await lookupHistoryWithStableContext({
      getContext: () => ({ signature: "stable" }), load, resolve: () => null,
    })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("持续变化的上下文有重查上限", async () => {
    let revision = 0;
    const load = vi.fn(async () => { revision += 1; return []; });
    expect(await lookupHistoryWithStableContext({
      getContext: () => ({ signature: String(revision) }), load, resolve: () => "stale",
    })).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
  });
});
