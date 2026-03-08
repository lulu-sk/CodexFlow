// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  GEMINI_PASTE_ENTER_DELAY_MS,
} from "./terminal-send";

const createTerminalAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/TerminalAdapter", () => ({
  createTerminalAdapter: createTerminalAdapterMock,
}));

import TerminalManager from "./TerminalManager";

describe("TerminalManager（Gemini 发送策略）", () => {
  afterEach(() => {
    try { vi.useRealTimers(); } catch {}
    try { createTerminalAdapterMock.mockReset(); } catch {}
  });

  /**
   * 中文说明：创建带事件分发能力的 hostPty stub，便于模拟 PTY 输出回显。
   */
  const createHostPtyStub = () => {
    const dataHandlersById = new Map<string, Set<(data: string) => void>>();
    const write = vi.fn();
    return {
      write,
      resize: vi.fn(),
      close: vi.fn(),
      onData: (id: string, handler: (data: string) => void) => {
        let handlers = dataHandlersById.get(id);
        if (!handlers) {
          handlers = new Set();
          dataHandlersById.set(id, handlers);
        }
        handlers.add(handler);
        return () => {
          const current = dataHandlersById.get(id);
          if (!current) return;
          current.delete(handler);
          if (current.size === 0) dataHandlersById.delete(id);
        };
      },
      emitData: (id: string, data: string) => {
        const handlers = dataHandlersById.get(id);
        if (!handlers) return;
        [...handlers].forEach((handler) => handler(data));
      },
    };
  };

  /**
   * 中文说明：创建最小可用的终端适配器 stub，避免单测依赖真实 xterm。
   */
  const createAdapterStub = () => {
    return {
      mount: vi.fn(() => ({ cols: 80, rows: 24 })),
      write: vi.fn(),
      paste: vi.fn(),
      onData: vi.fn(() => () => {}),
      resize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getScrollSnapshot: vi.fn(() => null),
      restoreScrollSnapshot: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      setAppearance: vi.fn(),
      dispose: vi.fn(),
    };
  };

  it("Gemini 会等待 PTY 回显静默后，再延迟发送 Enter", () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-gemini": "pty-gemini" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini");
    tm.setPty("tab-gemini", "pty-gemini");

    tm.sendTextAndEnter("tab-gemini", "第一行\n第二行", { providerId: "gemini" });

    expect(hostPty.write).toHaveBeenCalledWith(
      "pty-gemini",
      `${BRACKETED_PASTE_START}第一行\n第二行${BRACKETED_PASTE_END}`,
    );

    vi.advanceTimersByTime(400);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    hostPty.emitData("pty-gemini", "第一行");
    vi.advanceTimersByTime(31);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    hostPty.emitData("pty-gemini", "第二行");
    vi.advanceTimersByTime(31);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS - 1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini", "\r");

    tm.disposeAll(false);
  });
});
