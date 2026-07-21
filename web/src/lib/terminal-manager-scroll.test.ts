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

  /**
   * 中文说明：创建终端适配器 stub，便于断言焦点、滚动与 resize 调用。
   */
  const createAdapterStub = (overrides: Record<string, unknown> = {}) => {
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
      scrollToTop: vi.fn(),
      scrollToBottom: vi.fn(),
      dispose: vi.fn(),
      ...overrides,
    };
  };

  it("onTabDeactivated 会保存快照，onTabActivated 会恢复", () => {
    const snapshot = { viewportY: 42, baseY: 80, isAtBottom: false };
    const adapter: any = createAdapterStub({
      getScrollSnapshot: vi.fn(() => snapshot),
    });
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.ensurePersistentContainer("tab-a");
    tm.onTabDeactivated("tab-a");
    tm.onTabActivated("tab-a");

    expect(adapter.getScrollSnapshot).toHaveBeenCalled();
    expect(adapter.restoreScrollSnapshot).toHaveBeenCalledWith(snapshot);
    tm.disposeAll(false);
  });

  it("页面输入框已聚焦时，onTabActivated 不会抢走输入焦点", () => {
    const adapter: any = createAdapterStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.ensurePersistentContainer("tab-a");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    tm.onTabActivated("tab-a");

    expect(adapter.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    input.remove();
    tm.disposeAll(false);
  });

  it("contenteditable 空属性元素已聚焦时，onTabActivated 不会抢走输入焦点", () => {
    const adapter: any = createAdapterStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.ensurePersistentContainer("tab-editable");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    document.body.appendChild(editable);
    editable.focus();
    tm.onTabActivated("tab-editable");

    expect(adapter.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editable);
    editable.remove();
    tm.disposeAll(false);
  });

  it("没有历史快照时，onTabActivated 仍会触发一次对齐修复", () => {
    const adapter: any = createAdapterStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.ensurePersistentContainer("tab-b");
    tm.onTabActivated("tab-b");

    expect(adapter.restoreScrollSnapshot).toHaveBeenCalledWith(null);
    tm.disposeAll(false);
  });

  it("scrollToTop 与 scrollToBottom 会透传到适配器", () => {
    const adapter: any = createAdapterStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.ensurePersistentContainer("tab-c");
    tm.scrollToTop("tab-c");
    tm.scrollToBottom("tab-c");

    expect(adapter.scrollToTop).toHaveBeenCalledTimes(1);
    expect(adapter.scrollToBottom).toHaveBeenCalledTimes(1);
    tm.disposeAll(false);
  });

  it("导航触发的稳定滚底会创建适配器并透传跟随选项", () => {
    const adapter: any = createAdapterStub();
    createTerminalAdapterMock.mockReturnValue(adapter);
    const options = {
      followOutput: true,
      source: "history-resume",
    };

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.scrollToBottom("tab-follow", options);

    expect(createTerminalAdapterMock).toHaveBeenCalledTimes(1);
    expect(adapter.scrollToBottom).toHaveBeenCalledWith(options);
    tm.disposeAll(false);
  });

  it("页面输入框已聚焦时，attachToHost 不会抢走输入焦点", () => {
    const adapter: any = createAdapterStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    const host = document.createElement("div");
    const input = document.createElement("textarea");
    document.body.appendChild(host);
    document.body.appendChild(input);
    input.focus();

    tm.attachToHost("tab-d", host);

    expect(adapter.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    host.remove();
    input.remove();
    tm.disposeAll(false);
  });
});
