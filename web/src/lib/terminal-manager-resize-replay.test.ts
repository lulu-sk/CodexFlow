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
});
