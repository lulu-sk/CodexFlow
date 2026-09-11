// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { beforeEach, describe, expect, it, vi } from "vitest";

const historyReconcilerMocks = vi.hoisted(() => ({
  requestHistoryFastRefresh: vi.fn(),
}));

vi.mock("./historyReconciler", () => ({
  requestHistoryFastRefresh: historyReconcilerMocks.requestHistoryFastRefresh,
}));

import { findIndexedHistoryRecoveryTarget, requestHistoryListRecovery } from "./historyListRecovery";

describe("electron/historyListRecovery", () => {
  beforeEach(() => {
    historyReconcilerMocks.requestHistoryFastRefresh.mockReset();
  });

  it("索引已包含目标会话时不重复提交恢复", () => {
    const requested = requestHistoryListRecovery(
      { providerId: "codex", threadId: "session-1", cwd: "/workspace/project" },
      [{ providerId: "codex", id: "session-1" }],
      { projectWslPath: "/workspace/project" },
    );

    expect(requested).toBe(false);
    expect(historyReconcilerMocks.requestHistoryFastRefresh).not.toHaveBeenCalled();
  });

  it("索引缺少目标会话时只向协调器提交定向恢复", () => {
    const requested = requestHistoryListRecovery(
      {
        providerId: "CODEX",
        threadId: "session-2",
        cwd: "/workspace/project",
        startedAt: 1_777_406_400_000,
      },
      [{ providerId: "codex", id: "session-1" }],
      { projectWslPath: "/workspace/project" },
    );

    expect(requested).toBe(true);
    expect(historyReconcilerMocks.requestHistoryFastRefresh).toHaveBeenCalledTimes(1);
    expect(historyReconcilerMocks.requestHistoryFastRefresh).toHaveBeenCalledWith({
      providerId: "codex",
      threadId: "session-2",
      cwd: "/workspace/project",
      startedAt: 1_777_406_400_000,
      reason: "history-list-index-miss",
    });
  });

  it("拒绝未知 Provider 和没有会话线索的请求", () => {
    expect(requestHistoryListRecovery(
      { providerId: "custom", sessionId: "session-1" },
      [],
      {},
    )).toBe(false);
    expect(requestHistoryListRecovery(
      { providerId: "claude", cwd: "/workspace/project" },
      [],
      {},
    )).toBe(false);
    expect(historyReconcilerMocks.requestHistoryFastRefresh).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "gemini", "grok", "antigravity"])("%s 可直接命中第 250 条之后的旧会话", (providerId) => {
    const target = { providerId, id: "summary-old", resumeId: "session-old" };
    const items = [...Array.from({ length: 300 }, (_, index) => ({ providerId, id: `recent-${index}` })), target];
    const hint = { providerId, sessionId: "SESSION-OLD" };

    expect(findIndexedHistoryRecoveryTarget(hint, items)).toBe(target);
    expect(requestHistoryListRecovery(hint, items, {})).toBe(false);
    expect(historyReconcilerMocks.requestHistoryFastRefresh).not.toHaveBeenCalled();
  });

  it("精确查找不串到其他引擎或不在项目范围内的记录", () => {
    expect(findIndexedHistoryRecoveryTarget({ providerId: "codex", threadId: "session" }, [
      { providerId: "claude", id: "session" },
      { providerId: "codex", id: "other" },
    ])).toBeUndefined();
    expect(findIndexedHistoryRecoveryTarget({ providerId: "codex", threadId: "session" }, [])).toBeUndefined();
  });
});
