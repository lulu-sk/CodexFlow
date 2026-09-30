import { describe, expect, it } from "vitest";
import { historySessionKey } from "./session-key";

describe("历史会话合并编号", () => {
  it("同一 Codex 会话更换文件后仍替换同一条列表记录", () => {
    const session = { providerId: "codex", id: "thread", filePath: "original.jsonl" };
    expect(historySessionKey(session)).toBe(historySessionKey({ ...session, id: " THREAD ", filePath: "revision.jsonl" }));
    expect(historySessionKey(session)).not.toBe(historySessionKey({ ...session, id: "fork" }));
    expect(historySessionKey(session)).not.toBe(historySessionKey({ ...session, providerId: "claude" }));
  });
});
