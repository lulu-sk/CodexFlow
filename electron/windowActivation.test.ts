import { afterEach, describe, expect, it, vi } from "vitest";

const { appFocusMock } = vi.hoisted(() => ({
  appFocusMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
}));

import { activateWindowPreservingState } from "./windowActivation";

type MockBrowserWindow = {
  isMinimized: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isFullScreen: ReturnType<typeof vi.fn>;
  isAlwaysOnTop: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
};

/**
 * 中文说明：构造最小 BrowserWindow 测试替身，便于验证激活流程的调用分支。
 */
function createMockBrowserWindow(overrides?: Partial<MockBrowserWindow>): MockBrowserWindow {
  return {
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isFullScreen: vi.fn(() => false),
    isAlwaysOnTop: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  try { vi.clearAllMocks(); } catch {}
});

describe("electron/windowActivation.activateWindowPreservingState", () => {
  it("全屏且已可见时不会触发 show、置顶抖动或 moveTop", () => {
    const win = createMockBrowserWindow({
      isFullScreen: vi.fn(() => true),
    });

    const snapshot = activateWindowPreservingState(win as any, { platform: "win32" });

    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(win.moveTop).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(appFocusMock).toHaveBeenCalledTimes(1);
    expect(snapshot.wasFullScreen).toBe(true);
    expect(snapshot.usedShow).toBe(false);
    expect(snapshot.usedAlwaysOnTopHack).toBe(false);
    expect(snapshot.usedMoveTop).toBe(false);
  });

  it("最小化非全屏窗口会先恢复，再执行 Windows 前台激活流程", () => {
    const win = createMockBrowserWindow({
      isMinimized: vi.fn(() => true),
      isVisible: vi.fn(() => false),
    });

    const snapshot = activateWindowPreservingState(win as any, { platform: "win32" });

    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true);
    expect(win.setAlwaysOnTop).toHaveBeenNthCalledWith(2, false);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.moveTop).toHaveBeenCalledTimes(1);
    expect(snapshot.wasMinimized).toBe(true);
    expect(snapshot.usedRestore).toBe(true);
    expect(snapshot.usedAlwaysOnTopHack).toBe(true);
    expect(snapshot.usedMoveTop).toBe(true);
  });
});
