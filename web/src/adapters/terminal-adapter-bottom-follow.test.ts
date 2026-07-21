// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xtermHarness = vi.hoisted(() => ({
  instances: [] as any[],
}));

vi.mock("@xterm/xterm", () => {
  /**
   * 创建可控制 buffer 与 DOM viewport 的最小 xterm 替身。
   */
  const createFakeTerminal = () => {
    const scrollListeners = new Set<(viewportY: number) => void>();
    const dataListeners = new Set<(data: string) => void>();
    const activeBuffer = {
      viewportY: 8,
      baseY: 40,
      cursorY: 0,
      length: 41,
      type: "normal",
      getLine: vi.fn(() => null),
    };
    let viewport: HTMLDivElement | null = null;
    let viewportScrollTop = 80;

    /**
     * 同步替身的 DOM 滚动条位置。
     */
    const setViewportScrollTop = (value: number) => {
      viewportScrollTop = Math.max(0, Number(value || 0));
    };

    /**
     * 通知所有 xterm buffer 滚动订阅者。
     */
    const emitScroll = () => {
      for (const listener of scrollListeners) listener(activeBuffer.viewportY);
    };

    const terminal: any = {
      cols: 80,
      rows: 24,
      buffer: {
        active: activeBuffer,
        normal: activeBuffer,
      },
      unicode: { activeVersion: "6" },
      options: {},
      element: null,
      textarea: null,
      _core: {
        viewport: {
          syncScrollArea: vi.fn(),
        },
        _renderService: {
          dimensions: {
            css: {
              cell: { width: 8, height: 10 },
            },
          },
          clear: vi.fn(),
        },
      },
      loadAddon: vi.fn(),
      open: vi.fn((element: HTMLElement) => {
        viewport = document.createElement("div");
        viewport.className = "xterm-viewport";
        Object.defineProperties(viewport, {
          clientWidth: { configurable: true, get: () => 800 },
          clientHeight: { configurable: true, get: () => 400 },
          scrollHeight: { configurable: true, get: () => 1000 },
          scrollTop: {
            configurable: true,
            get: () => viewportScrollTop,
            set: (value: number) => setViewportScrollTop(value),
          },
        });
        const textarea = document.createElement("textarea");
        textarea.className = "xterm-helper-textarea";
        element.append(viewport, textarea);
        terminal.element = element;
        terminal.textarea = textarea;
      }),
      onScroll: vi.fn((listener: (viewportY: number) => void) => {
        scrollListeners.add(listener);
        return { dispose: () => scrollListeners.delete(listener) };
      }),
      onData: vi.fn((listener: (data: string) => void) => {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      }),
      attachCustomKeyEventHandler: vi.fn(),
      scrollToBottom: vi.fn(() => {
        activeBuffer.viewportY = activeBuffer.baseY;
        setViewportScrollTop(600);
        emitScroll();
      }),
      scrollToTop: vi.fn(() => {
        activeBuffer.viewportY = 0;
        setViewportScrollTop(0);
        emitScroll();
      }),
      scrollToLine: vi.fn((line: number) => {
        activeBuffer.viewportY = Math.max(0, Math.min(activeBuffer.baseY, line));
        setViewportScrollTop(activeBuffer.viewportY * 10);
        emitScroll();
      }),
      write: vi.fn((_data: string, callback?: () => void) => callback?.()),
      paste: vi.fn(),
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
      refresh: vi.fn(),
      clearTextureAtlas: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ""),
      clearSelection: vi.fn(),
      selectAll: vi.fn(),
      dispose: vi.fn(),
      __activeBuffer: activeBuffer,
      __getViewport: () => viewport,
      __setViewportScrollTop: setViewportScrollTop,
      __emitScroll: emitScroll,
    };
    xtermHarness.instances.push(terminal);
    return terminal;
  };

  return {
    Terminal: vi.fn(function TerminalMock() {
      return createFakeTerminal();
    }),
  };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(function WebLinksAddonMock() {
    return {};
  }),
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: vi.fn(function Unicode11AddonMock() {
    return {};
  }),
}));

vi.mock("@/i18n/setup", () => ({
  default: { t: (key: string) => key },
}));

import { createTerminalAdapter, type TerminalAdapterAPI } from "./TerminalAdapter";

describe("TerminalAdapter（持续底部跟随）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    xtermHarness.instances.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    ));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * 创建已连接到文档且具有可用 viewport 尺寸的终端适配器。
   */
  const createMountedAdapter = (): {
    adapter: TerminalAdapterAPI;
    terminal: any;
    viewport: HTMLDivElement;
  } => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const adapter = createTerminalAdapter();
    adapter.mount(host);
    const terminal = xtermHarness.instances.at(-1);
    const viewport = terminal.__getViewport() as HTMLDivElement | null;
    if (!viewport) throw new Error("测试终端未创建 viewport");
    return { adapter, terminal, viewport };
  };

  /**
   * 把替身终端移动到指定的非底部位置，模拟延迟重排造成的位置漂移。
   */
  const moveAwayFromBottom = (terminal: any, viewportY = 6): void => {
    terminal.__activeBuffer.viewportY = viewportY;
    terminal.__setViewportScrollTop(viewportY * 10);
  };

  /**
   * 为 jsdom 中的终端 viewport 提供可用于滚动条命中判断的实际边界。
   */
  const mockViewportRect = (viewport: HTMLDivElement): void => {
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      width: 800,
      height: 400,
      toJSON: () => ({}),
    });
  };

  it("挂载前的跟随请求会待命，并在终端可见后自动滚到底部", async () => {
    const adapter = createTerminalAdapter();
    adapter.scrollToBottom({ followOutput: true, source: "notification-focus" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(xtermHarness.instances).toHaveLength(0);

    const host = document.createElement("div");
    document.body.appendChild(host);
    adapter.mount(host);
    const terminal = xtermHarness.instances.at(-1);
    await vi.advanceTimersByTimeAsync(100);

    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);
    adapter.dispose();
  });

  it("稳定后仍会纠正延迟快照恢复、输出与 resize 漂移", async () => {
    const { adapter, terminal } = createMountedAdapter();
    adapter.scrollToBottom({
      followOutput: true,
      source: "history-resume",
    });

    await vi.advanceTimersByTimeAsync(1200);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);
    const settledCallCount = terminal.scrollToBottom.mock.calls.length;

    moveAwayFromBottom(terminal);
    adapter.restoreScrollSnapshot({ viewportY: 6, baseY: 40, isAtBottom: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);
    expect(terminal.scrollToBottom.mock.calls.length).toBeGreaterThan(settledCallCount);

    await vi.advanceTimersByTimeAsync(1200);
    moveAwayFromBottom(terminal, 4);
    adapter.write("delayed output");
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);

    await vi.advanceTimersByTimeAsync(1200);
    moveAwayFromBottom(terminal, 3);
    adapter.notifyLayoutResizeStart?.("composer");
    adapter.notifyPtyResizePending?.({ cols: 80, rows: 23 }, "composer");
    adapter.resizeTo?.({ cols: 80, rows: 23 }, "composer");
    adapter.notifyPtyResizeComplete?.({ cols: 80, rows: 23 }, "composer", "sent");
    await vi.advanceTimersByTimeAsync(300);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);

    adapter.dispose();
  });

  it("待命后会纠正没有显式活动来源的 buffer 与 DOM 程序性滚动", async () => {
    const { adapter, terminal, viewport } = createMountedAdapter();
    adapter.scrollToBottom({ followOutput: true, source: "history-resume" });
    await vi.advanceTimersByTimeAsync(1200);

    moveAwayFromBottom(terminal, 6);
    terminal.__emitScroll();
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);

    await vi.advanceTimersByTimeAsync(1200);
    terminal.__setViewportScrollTop(0);
    viewport.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);
    expect(viewport.scrollTop).toBe(600);

    adapter.dispose();
  });

  it("普通点击保持跟随，真实滚轮则解除跟随并允许阅读历史输出", async () => {
    const { adapter, terminal, viewport } = createMountedAdapter();
    mockViewportRect(viewport);
    adapter.scrollToBottom({ followOutput: true, source: "notification-focus" });
    await vi.advanceTimersByTimeAsync(1200);

    viewport.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 100 }));
    moveAwayFromBottom(terminal, 7);
    terminal.__emitScroll();
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);
    window.dispatchEvent(new Event("pointerup"));
    adapter.write("output after focus click");
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.__activeBuffer.viewportY).toBe(terminal.__activeBuffer.baseY);

    await vi.advanceTimersByTimeAsync(1200);
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    moveAwayFromBottom(terminal, 5);
    const callCountAfterWheel = terminal.scrollToBottom.mock.calls.length;
    adapter.write("output after user scroll");
    adapter.restoreScrollSnapshot({ viewportY: 5, baseY: 40, isAtBottom: false });
    await vi.advanceTimersByTimeAsync(1500);

    expect(terminal.__activeBuffer.viewportY).toBe(5);
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(callCountAfterWheel);

    adapter.dispose();
  });

  it("拖动终端滚动条会解除跟随并保留用户选择的位置", async () => {
    const { adapter, terminal, viewport } = createMountedAdapter();
    mockViewportRect(viewport);
    adapter.scrollToBottom({ followOutput: true, source: "notification-focus" });
    await vi.advanceTimersByTimeAsync(1200);

    viewport.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 796, clientY: 100 }));
    moveAwayFromBottom(terminal, 5);
    viewport.dispatchEvent(new Event("scroll"));
    terminal.__emitScroll();
    window.dispatchEvent(new Event("pointerup"));
    const callCountAfterDrag = terminal.scrollToBottom.mock.calls.length;

    adapter.write("output after scrollbar drag");
    await vi.advanceTimersByTimeAsync(1500);

    expect(terminal.__activeBuffer.viewportY).toBe(5);
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(callCountAfterDrag);
    adapter.dispose();
  });

  it("尺寸重排期间拖动滚动条不会被底部锚点覆盖", async () => {
    const { adapter, terminal, viewport } = createMountedAdapter();
    mockViewportRect(viewport);
    adapter.scrollToBottom({ followOutput: true, source: "notification-focus" });
    await vi.advanceTimersByTimeAsync(1200);

    adapter.notifyLayoutResizeStart?.("composer");
    adapter.notifyPtyResizePending?.({ cols: 80, rows: 23 }, "composer");
    viewport.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 796, clientY: 100 }));
    moveAwayFromBottom(terminal, 5);
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("pointerup"));

    const callCountAfterDrag = terminal.scrollToBottom.mock.calls.length;
    adapter.write("output after resize drag");
    await vi.advanceTimersByTimeAsync(1500);

    expect(terminal.__activeBuffer.viewportY).toBe(5);
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(callCountAfterDrag);
    adapter.dispose();
  });
});
