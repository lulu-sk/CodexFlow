// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const createTerminalAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/TerminalAdapter", () => ({
  createTerminalAdapter: createTerminalAdapterMock,
}));

import TerminalManager from "./TerminalManager";

describe("TerminalManager（终端按键上下文）", () => {
  it("向适配器传递所属标签页的实时引擎，不串用其他标签页", () => {
    const providers: Record<string, string> = { "tab-a": "codex", "tab-b": "shell" };
    createTerminalAdapterMock.mockReturnValue({
      mount: vi.fn(), setAppearance: vi.fn(), dispose: vi.fn(),
    });
    const tm = new TerminalManager(undefined, createHostPtyStub(), {}, (tabId) => providers[tabId]);
    try {
      tm.ensurePersistentContainer("tab-a");
      const codexOptions = createTerminalAdapterMock.mock.lastCall![0];
      tm.ensurePersistentContainer("tab-b");
      const shellOptions = createTerminalAdapterMock.mock.lastCall![0];
      expect(codexOptions.getProviderId()).toBe("codex");
      expect(shellOptions.getProviderId()).toBe("shell");

      providers["tab-a"] = "claude";
      expect(codexOptions.getProviderId()).toBe("claude");
    } finally {
      tm.disposeAll(false);
      createTerminalAdapterMock.mockReset();
    }
  });
});

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
      readProgramStatus: vi.fn(() => ({ state: "done", app: "claude-code", id: "", message: "完成", receivedAt: 1000 })),
      hasPendingWriteWork: vi.fn(() => true),
      readCursorTextSnapshot: vi.fn(() => snapshot),
    };
    (tm as any).adapters["tab-a"] = adapter;

    expect(tm.hasPendingTerminalOutput("tab-a")).toBe(true);
    expect(tm.readTerminalCursorTextSnapshot("tab-a", { linesBefore: 32 })).toBe(snapshot);
    expect(adapter.readCursorTextSnapshot).toHaveBeenCalledWith({ linesBefore: 32 });
    expect(tm.readTerminalCursorTextSnapshot("missing-tab")).toBeNull();
    expect(tm.readTerminalProgramStatus("tab-a")).toEqual(adapter.readProgramStatus());
    expect(tm.readTerminalProgramStatus("missing-tab")).toBeNull();
  });
});
