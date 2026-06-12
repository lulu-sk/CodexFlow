// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const createTerminalAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/TerminalAdapter", () => ({
  createTerminalAdapter: createTerminalAdapterMock,
}));

import TerminalManager from "./TerminalManager";

describe("TerminalManager（PTY 尾部回放）", () => {
  afterEach(() => {
    try { vi.useRealTimers(); } catch {}
    try { createTerminalAdapterMock.mockReset(); } catch {}
  });

  /**
   * 创建最小可用的终端适配器 stub，便于断言 backlog 写入次数。
   */
  function createAdapterStub() {
    return {
      mount: vi.fn(() => ({ cols: 80, rows: 24 })),
      write: vi.fn(),
      paste: vi.fn(),
      onData: vi.fn(() => () => {}),
      resize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getScrollSnapshot: vi.fn(() => null),
      restoreScrollSnapshot: vi.fn(),
      readCursorTextSnapshot: vi.fn(() => null),
      focus: vi.fn(),
      blur: vi.fn(),
      setAppearance: vi.fn(),
      dispose: vi.fn(),
    };
  }

  /**
   * 创建带可控 backlog promise 的 hostPty stub。
   */
  function createHostPtyStub() {
    const backlogResolvers: Array<(value: { ok: boolean; data?: string }) => void> = [];
    return {
      backlogResolvers,
      onData: vi.fn(() => () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      backlog: vi.fn(() => new Promise<{ ok: boolean; data?: string }>((resolve) => {
        backlogResolvers.push(resolve);
      })),
    };
  }

  it("同一 tab+pty 的并发 hydrate 只拉取并写入一次 backlog", async () => {
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-a": "pty-a" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});

    tm.setPty("tab-a", "pty-a", { hydrateBacklog: true });
    tm.setPty("tab-a", "pty-a", { hydrateBacklog: true });

    expect(hostPty.backlog).toHaveBeenCalledTimes(1);
    expect(hostPty.pause).toHaveBeenCalledTimes(1);
    expect(hostPty.onData).toHaveBeenCalledTimes(2);

    hostPty.backlogResolvers[0]?.({ ok: true, data: "历史输出" });
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.write.mock.calls.filter((call: any[]) => call[0] === "历史输出")).toHaveLength(1);
    expect(hostPty.resume).toHaveBeenCalledWith("pty-a");

    tm.disposeAll(false);
  });

  it("旧 PTY 的延迟 backlog 返回后不会写入已换绑的 tab", async () => {
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-a": "pty-old" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});

    tm.setPty("tab-a", "pty-old", { hydrateBacklog: true });
    ptyByTab["tab-a"] = "pty-new";
    tm.setPty("tab-a", "pty-new");

    hostPty.backlogResolvers[0]?.({ ok: true, data: "旧历史输出" });
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.write.mock.calls.some((call: any[]) => call[0] === "旧历史输出")).toBe(false);
    expect(hostPty.resume).toHaveBeenCalledWith("pty-old");

    tm.disposeAll(false);
  });
});
