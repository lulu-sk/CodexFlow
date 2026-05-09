import { describe, expect, it, vi } from "vitest";
import {
  normalizePersistedCommitMessage,
  readLastCommitMessage,
  resolveInitialCommitMessage,
  shouldPersistLastCommitMessage,
  writeLastCommitMessage,
} from "./message-policy";

describe("commit message policy", () => {
  it("非 changelist 模式应优先回填最近一次持久化消息", () => {
    expect(resolveInitialCommitMessage({
      currentMessage: "",
      persistedMessage: "recent message",
      changeListDraftMessage: "draft message",
      changeListsEnabled: false,
      stagingAreaEnabled: false,
      commitAmendEnabled: false,
    })).toBe("recent message");
  });

  it("changelist 模式应继续以活动列表草稿为主", () => {
    expect(resolveInitialCommitMessage({
      currentMessage: "",
      persistedMessage: "recent message",
      changeListDraftMessage: "draft message",
      changeListsEnabled: true,
      stagingAreaEnabled: false,
      commitAmendEnabled: false,
    })).toBe("draft message");
  });

  it("应按 cleanup 规则决定是否持久化最近消息", () => {
    expect(shouldPersistLastCommitMessage("feat: add bridge", false)).toBe(true);
    expect(shouldPersistLastCommitMessage("# template only", true)).toBe(false);
    expect(normalizePersistedCommitMessage("a\r\nb")).toBe("a\nb");
  });

  it("空白消息写入时应清理持久化值", () => {
    const storage = {
      getItem: vi.fn(() => "last message"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    writeLastCommitMessage(storage, "  ");

    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(readLastCommitMessage(storage)).toBe("last message");
  });
});
