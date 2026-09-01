import { describe, expect, it } from "vitest";

import type { HistoryMessage, HistorySession } from "@/app/app-shared";
import {
  buildHistoryDetailSessionFingerprint,
  shouldReuseHistoryDetailLoad,
  upsertHistoryDetailSessionMessages,
} from "@/features/history/detail-message-cache";

const SESSION: HistorySession = {
  providerId: "codex",
  id: "session-a",
  title: "会话 A",
  date: "2026-01-01T00:00:00.000Z",
  messages: [],
};

const MESSAGES: HistoryMessage[] = [{
  role: "assistant",
  content: [{ type: "output_text", text: "正文" }],
}];

describe("history detail message cache", () => {
  it("相同会话的元数据对象被重新创建时仍生成相同读取指纹", () => {
    const first = { ...SESSION, filePath: "C:\\workspace\\session.jsonl" };
    const refreshed = { ...first };

    expect(buildHistoryDetailSessionFingerprint(first)).toBe(
      buildHistoryDetailSessionFingerprint(refreshed),
    );
  });

  it("索引更新版本变化时会生成新的读取指纹", () => {
    const first = { ...SESSION, filePath: "C:\\workspace\\session.jsonl" };

    expect(buildHistoryDetailSessionFingerprint(first, 1)).not.toBe(
      buildHistoryDetailSessionFingerprint(first, 2),
    );
  });

  it("曾读取到正文但切换项目后缓存被裁剪时重新读取", () => {
    expect(shouldReuseHistoryDetailLoad({
      lastLoadedFingerprint: "session-a-v1",
      requestedFingerprint: "session-a-v1",
      lastLoadedMessageCount: 12,
      cachedMessageCount: 0,
    })).toBe(false);
  });

  it("真实缓存仍有正文或上次确认是空会话时复用结果", () => {
    expect(shouldReuseHistoryDetailLoad({
      lastLoadedFingerprint: "session-a-v1",
      requestedFingerprint: "session-a-v1",
      lastLoadedMessageCount: 12,
      cachedMessageCount: 12,
    })).toBe(true);
    expect(shouldReuseHistoryDetailLoad({
      lastLoadedFingerprint: "session-a-v1",
      requestedFingerprint: "session-a-v1",
      lastLoadedMessageCount: 0,
      cachedMessageCount: 0,
    })).toBe(true);
  });

  it("读取完成时目标会话暂时不在本地列表也会补入正文", () => {
    const result = upsertHistoryDetailSessionMessages([], SESSION, MESSAGES);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ ...SESSION, messages: MESSAGES });
  });
});
