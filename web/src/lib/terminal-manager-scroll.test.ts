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
    vi.unstubAllGlobals();
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

  it("普通布局尺寸变化时会提前保存底部锚点，尺寸未变时不会重复通知", () => {
    const notifyLayoutResizeStart = vi.fn();
    const adapter: any = createAdapterStub({ notifyLayoutResizeStart });
    createTerminalAdapterMock.mockReturnValue(adapter);

    let triggerResizeObserver: (() => void) | undefined;
    class ResizeObserverMock {
      private readonly callback: ResizeObserverCallback;

      /**
       * 保存观察回调，供测试模拟普通布局尺寸变化。
       * @param callback 尺寸观察回调
       */
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        triggerResizeObserver = () => this.callback([], this as unknown as ResizeObserver);
      }

      /** 开始观察测试元素。 */
      observe(): void {}

      /** 停止观察单个测试元素。 */
      unobserve(): void {}

      /** 停止全部测试观察。 */
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));

    let hostHeight = 600;
    let parentHeight = 600;
    const parent = document.createElement("div");
    const host = document.createElement("div");
    parent.appendChild(host);
    document.body.appendChild(parent);
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: hostHeight,
      left: 0,
      width: 800,
      height: hostHeight,
      toJSON: () => ({}),
    }));
    vi.spyOn(parent, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: parentHeight,
      left: 0,
      width: 800,
      height: parentHeight,
      toJSON: () => ({}),
    }));

    const tm = new TerminalManager(() => undefined, createHostPtyStub() as any, {});
    tm.attachToHost("tab-layout", host);

    triggerResizeObserver?.();
    expect(notifyLayoutResizeStart).not.toHaveBeenCalled();

    hostHeight = 480;
    parentHeight = 480;
    triggerResizeObserver?.();
    expect(notifyLayoutResizeStart).toHaveBeenCalledTimes(1);
    expect(notifyLayoutResizeStart).toHaveBeenCalledWith("ro-layout");

    triggerResizeObserver?.();
    expect(notifyLayoutResizeStart).toHaveBeenCalledTimes(1);

    tm.disposeAll(false);
    parent.remove();
  });
});
