import { describe, expect, it } from "vitest";
import { expandAntigravityConversationDeleteCandidates, isAntigravityConversationDbPath } from "./historyDelete";

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
});
