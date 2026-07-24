import { describe, expect, it } from "vitest";
import {
  expandAntigravityConversationDeleteCandidates,
  expandHistoryDeleteCandidates,
  isAntigravityConversationDbPath,
  isGrokSessionSummaryPath,
} from "./historyDelete";

describe("electron/historyDelete", () => {
  it("识别 Antigravity conversation SQLite 主库", () => {
    expect(isAntigravityConversationDbPath("C:\\Users\\user\\.gemini\\antigravity-cli\\conversations\\session-1.db")).toBe(true);
    expect(isAntigravityConversationDbPath("C:\\Users\\user\\.gemini\\antigravity-cli\\conversations\\session-1.db-wal")).toBe(false);
    expect(isAntigravityConversationDbPath("C:\\Users\\user\\.gemini\\chats\\session-1.db")).toBe(false);
  });

  it("删除 Antigravity DB 时会一起带上 SQLite 辅助文件", () => {
    const db = "C:\\Users\\user\\.gemini\\antigravity-cli\\conversations\\session-1.db";

    expect(expandAntigravityConversationDeleteCandidates([db])).toEqual([
      db,
      `${db}-wal`,
      `${db}-shm`,
      `${db}-journal`,
    ]);
  });

  it("普通历史文件不会被扩展删除候选", () => {
    const filePath = "C:\\Users\\user\\.codex\\sessions\\2026\\06\\21\\rollout.jsonl";

    expect(expandAntigravityConversationDeleteCandidates([filePath])).toEqual([filePath]);
  });

  it("删除 Grok summary.json 时会回收整个会话目录", () => {
    const grokSessionRoots = [
      "X:\\fixture\\.grok\\sessions",
      "X:\\grok-data\\sessions\\",
      "\\\\wsl.localhost\\TestDistro\\opt\\grok-home\\sessions",
    ];
    const defaultSummaryPath = "X:\\fixture\\.grok\\sessions\\encoded-project\\session-1\\summary.json";
    const customSummaryPath = "X:\\grok-data\\sessions\\encoded-project\\session-2\\summary.json";
    const wslSummaryPath = "\\\\wsl.localhost\\TestDistro\\opt\\grok-home\\sessions\\encoded-project\\session-3\\summary.json";
    const otherAppSummaryPath = "X:\\OtherApp\\sessions\\tenant-a\\record-1\\summary.json";
    const traversalSummaryPath = "X:\\fixture\\.grok\\sessions\\..\\..\\summary.json";

    expect(isGrokSessionSummaryPath(defaultSummaryPath, grokSessionRoots)).toBe(true);
    expect(isGrokSessionSummaryPath(customSummaryPath, grokSessionRoots)).toBe(true);
    expect(isGrokSessionSummaryPath(wslSummaryPath, grokSessionRoots)).toBe(true);
    expect(isGrokSessionSummaryPath(otherAppSummaryPath, grokSessionRoots)).toBe(false);
    expect(isGrokSessionSummaryPath(traversalSummaryPath, grokSessionRoots)).toBe(false);
    expect(isGrokSessionSummaryPath("X:\\fixture\\sessions\\summary.json", grokSessionRoots)).toBe(false);
    expect(isGrokSessionSummaryPath("X:\\fixture\\summary.json", grokSessionRoots)).toBe(false);
    expect(expandHistoryDeleteCandidates(
      [defaultSummaryPath, customSummaryPath, wslSummaryPath, otherAppSummaryPath, traversalSummaryPath],
      grokSessionRoots,
    )).toEqual([
      "X:\\fixture\\.grok\\sessions\\encoded-project\\session-1",
      "X:\\grok-data\\sessions\\encoded-project\\session-2",
      "\\\\wsl.localhost\\TestDistro\\opt\\grok-home\\sessions\\encoded-project\\session-3",
      otherAppSummaryPath,
      traversalSummaryPath,
    ]);
  });

  it("POSIX 路径应保持正斜杠并回收整个 Grok 会话目录", () => {
    const root = "/home/test-user/.grok/sessions";
    const summaryPath = `${root}/encoded-project/session-1/summary.json`;

    expect(isGrokSessionSummaryPath(summaryPath, [root])).toBe(true);
    expect(expandHistoryDeleteCandidates([summaryPath], [root])).toEqual([
      `${root}/encoded-project/session-1`,
    ]);
  });
});
