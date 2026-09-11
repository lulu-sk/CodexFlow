// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const createTerminalAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/TerminalAdapter", () => ({
  createTerminalAdapter: createTerminalAdapterMock,
}));

import TerminalManager from "./TerminalManager";

/**
 * 创建 TerminalManager 测试所需的最小 PTY 宿主。
 */
function createHostPtyStub() {
  return {
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  };
}

describe("TerminalManager（PTY 缩放重绘窗口）", () => {
  it("没有缩放活动时返回 false", () => {
    const tm = new TerminalManager(() => "pty-a", createHostPtyStub() as any, {});

    expect(tm.isPtyResizeReplayWindowActive("tab-a")).toBe(false);
  });

  it("等待下发 PTY resize 时返回 true", () => {
    const tm = new TerminalManager(() => "pty-a", createHostPtyStub() as any, {});
    (tm as any).pendingPtyResizeTimerByTab["tab-a"] = 1;

    expect(tm.isPtyResizeReplayWindowActive("tab-a")).toBe(true);
  });

  it("PTY resize 后只在保护时间内返回 true", () => {
    const tm = new TerminalManager(() => "pty-a", createHostPtyStub() as any, {});
    const now = vi.spyOn(tm as any, "nowMs");
    (tm as any).lastPtyResizeAtByTab["tab-a"] = 1_000;

    now.mockReturnValue(3_500);
    expect(tm.isPtyResizeReplayWindowActive("tab-a")).toBe(true);

    now.mockReturnValue(3_501);
    expect(tm.isPtyResizeReplayWindowActive("tab-a")).toBe(false);
  });

  it("屏幕确认接口会读取适配器的待写状态和光标附近文本", () => {
    const tm = new TerminalManager(() => "pty-a", createHostPtyStub() as any, {});
    const snapshot = {
      bufferType: "normal",
      cursorAbsY: 12,
      startAbsY: 8,
      endAbsY: 12,
      lines: ["■ error", "› Ask Codex to do anything"],
      text: "■ error\n› Ask Codex to do anything",
    };
    const adapter = {
      hasPendingWriteWork: vi.fn(() => true),
      readCursorTextSnapshot: vi.fn(() => snapshot),
    };
    (tm as any).adapters["tab-a"] = adapter;

    expect(tm.hasPendingTerminalOutput("tab-a")).toBe(true);
    expect(tm.readTerminalCursorTextSnapshot("tab-a", { linesBefore: 32 })).toBe(snapshot);
    expect(adapter.readCursorTextSnapshot).toHaveBeenCalledWith({ linesBefore: 32 });
    expect(tm.readTerminalCursorTextSnapshot("missing-tab")).toBeNull();
  });
});
