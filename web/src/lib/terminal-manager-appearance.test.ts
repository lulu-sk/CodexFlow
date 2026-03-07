// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const createTerminalAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/TerminalAdapter", () => ({
  createTerminalAdapter: createTerminalAdapterMock,
}));

import TerminalManager from "./TerminalManager";

describe("TerminalManager（终端外观同步）", () => {
  afterEach(() => {
    try { createTerminalAdapterMock.mockReset(); } catch {}
  });

  const createHostPtyStub = () => ({
    onData: () => () => {},
    write: () => {},
    resize: () => {},
    close: () => {},
  });

  it("仅字号变化时也会下发到 adapter", () => {
    const adapter = {
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

    const manager = new TerminalManager(() => undefined, createHostPtyStub(), {
      fontFamily: "Menlo",
      fontSize: 13,
      theme: "campbell",
    });

    manager.ensurePersistentContainer("tab-a");
    adapter.setAppearance.mockClear();

    manager.setAppearance({ fontSize: 16 });

    expect(adapter.setAppearance).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: "Menlo",
        fontSize: 16,
        theme: "campbell",
      })
    );

    manager.disposeAll(false);
  });

  it("字号清空时会恢复默认字号链路", () => {
    const adapter = {
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

    const manager = new TerminalManager(() => undefined, createHostPtyStub(), {
      fontFamily: "Menlo",
      fontSize: 16,
      theme: "campbell",
    });

    manager.ensurePersistentContainer("tab-b");
    adapter.setAppearance.mockClear();

    manager.setAppearance({ fontSize: undefined });

    expect(adapter.setAppearance).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: "Menlo",
        fontSize: undefined,
        theme: "campbell",
      })
    );

    manager.disposeAll(false);
  });
});
