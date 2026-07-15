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
      ready: vi.fn(),
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
    expect(hostPty.ready).toHaveBeenCalledTimes(2);
    expect(hostPty.ready).toHaveBeenLastCalledWith("pty-a", {
      foreground: "#CCCCCC",
      background: "#0C0C0C",
    });

    hostPty.backlogResolvers[0]?.({ ok: true, data: "历史输出" });
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.write.mock.calls.filter((call: any[]) => call[0] === "历史输出")).toHaveLength(1);
    expect(hostPty.resume).toHaveBeenCalledWith("pty-a");

    tm.disposeAll(false);
  });

  it("首次绑定和切换主题时都应同步当前终端前景色与背景色", () => {
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-a": "pty-a" };
    const tm = new TerminalManager(
      (tabId) => ptyByTab[tabId],
      hostPty as any,
      { theme: "dracula" },
    );

    tm.setPty("tab-a", "pty-a");
    expect(hostPty.ready).toHaveBeenLastCalledWith("pty-a", {
      foreground: "#F8F8F2",
      background: "#282A36",
    });

    hostPty.ready.mockClear();
    tm.setAppearance({ theme: "catppuccin-latte" });
    expect(hostPty.ready).toHaveBeenCalledTimes(1);
    expect(hostPty.ready).toHaveBeenCalledWith("pty-a", {
      foreground: "#4C4F69",
      background: "#EFF1F5",
    });

    tm.disposeAll(false);
  });

  it("首次绑定应先发送 resize 暂停与尺寸，再通知主进程 ready", () => {
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(
      () => "pty-a",
      hostPty as any,
      {},
    );

    tm.setPty("tab-a", "pty-a");

    expect(hostPty.pause).toHaveBeenCalledWith("pty-a");
    expect(hostPty.resize).toHaveBeenCalledWith("pty-a", 80, 24);
    expect(hostPty.pause.mock.invocationCallOrder[0]).toBeLessThan(
      hostPty.ready.mock.invocationCallOrder[0],
    );
    expect(hostPty.resize.mock.invocationCallOrder[0]).toBeLessThan(
      hostPty.ready.mock.invocationCallOrder[0],
    );

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
