// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";

const createTerminalAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/TerminalAdapter", () => ({
  createTerminalAdapter: createTerminalAdapterMock,
}));

import TerminalManager from "./TerminalManager";

describe("TerminalManager（终端滚动快照）", () => {
  afterEach(() => {
    try { createTerminalAdapterMock.mockReset(); } catch {}
  });

  /**
   * 中文说明：创建最小可用的 hostPty stub，避免单测触碰真实 IPC。
   */
  const createHostPtyStub = () => {
    return {
      onData: () => () => {},
      write: () => {},
      resize: () => {},
      close: () => {},
    };
  };

  it("onTabDeactivated 会保存快照，onTabActivated 会恢复", () => {
    const snapshot = { viewportY: 42, baseY: 80, isAtBottom: false };
    const adapter: any = {
      mount: vi.fn(() => ({ cols: 80, rows: 24 })),
      write: vi.fn(),
      paste: vi.fn(),
      onData: vi.fn(() => () => {}),
      resize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getScrollSnapshot: vi.fn(() => snapshot),
      restoreScrollSnapshot: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      setAppearance: vi.fn(),
      dispose: vi.fn(),
    };
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.ensurePersistentContainer("tab-a");
    tm.onTabDeactivated("tab-a");
    tm.onTabActivated("tab-a");

    expect(adapter.getScrollSnapshot).toHaveBeenCalled();
    expect(adapter.restoreScrollSnapshot).toHaveBeenCalledWith(snapshot);
    tm.disposeAll(false);
  });

  it("没有历史快照时，onTabActivated 仍会触发一次对齐修复", () => {
    const adapter: any = {
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
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.ensurePersistentContainer("tab-b");
    tm.onTabActivated("tab-b");

    expect(adapter.restoreScrollSnapshot).toHaveBeenCalledWith(null);
    tm.disposeAll(false);
  });
});
