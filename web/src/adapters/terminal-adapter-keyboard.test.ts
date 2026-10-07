// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalAdapterAPI } from "./TerminalAdapter";
import * as clipboard from "@/lib/clipboard";

vi.mock("@/i18n/setup", () => ({
  default: { t: (key: string) => key },
}));

describe("TerminalAdapter（真实 xterm 键盘输入）", () => {
  let createTerminalAdapter: typeof import("./TerminalAdapter").createTerminalAdapter;
  let adapter: TerminalAdapterAPI;
  let textarea: HTMLTextAreaElement;
  let providerId: string;
  let outbound: string[];

  beforeAll(async () => {
    // xterm 在加载模块时也会探测画布，需在动态导入前提供替身。
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    ({ createTerminalAdapter } = await import("./TerminalAdapter"));
    canvas.mockRestore();
  });

  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    // jsdom 没有画布；保留真实 xterm 的按键处理与 onData 链路。
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    providerId = "codex";
    outbound = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    adapter = createTerminalAdapter({ getProviderId: () => providerId });
    adapter.mount(host);
    adapter.onData((data) => outbound.push(data));
    textarea = host.querySelector("textarea")!;
    textarea.focus();
  });

  afterEach(() => {
    adapter?.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 把完整按键生命周期送入真实 xterm 的输入框。 */
  function pressKey(key: string, keyCode: number, modifiers: KeyboardEventInit = {}): KeyboardEvent {
    const init = { key, keyCode, bubbles: true, cancelable: true, ...modifiers };
    const down = new KeyboardEvent("keydown", init);
    textarea.dispatchEvent(down);
    textarea.dispatchEvent(new KeyboardEvent("keyup", init));
    return down;
  }

  /** 等待真实终端写入完成，避免在模式尚未生效时点击滚动按钮。 */
  async function renderTerminal(text: string): Promise<void> {
    adapter.write(text);
    await vi.waitFor(() => expect(adapter.hasPendingWriteWork?.()).toBe(false));
  }

  it("新版 Codex 的上下滚动按钮通过输入链路跳转历史端点", async () => {
    await renderTerminal("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[20;1H› Ask Codex to do anything");
    outbound.length = 0;
    adapter.scrollToTop();
    adapter.scrollToBottom();
    expect(outbound).toEqual(["\x1b[1;5H", "\x1b[1;5F"]);
  });

  it.each(["shell", "claude", "gemini"])("%s 全屏界面的滚动按钮不发送 Codex 跳转键", async (provider) => {
    providerId = provider;
    await renderTerminal("\x1b[?1049h\x1b[?1003h\x1b[20;1H› Ask Codex to do anything");
    outbound.length = 0;
    adapter.scrollToTop();
    adapter.scrollToBottom();
    expect(outbound).toEqual([]);
  });

  it("旧版 Codex 普通缓冲区滚动按钮不向会话发送按键", async () => {
    await renderTerminal("› Ask Codex to do anything");
    outbound.length = 0;
    adapter.scrollToTop();
    adapter.scrollToBottom();
    expect(outbound).toEqual([]);
  });

  it("新版草稿和持续滚底请求也能跳转，但无输入框的弹窗不注入按键", async () => {
    await renderTerminal("\x1b[?1049h\x1b[?1003h\x1b[20;1H› 尚未发送的草稿");
    outbound.length = 0;
    adapter.scrollToBottom({ followOutput: true, source: "history-resume" });
    expect(outbound).toEqual(["\x1b[1;5F"]);

    await renderTerminal("\x1b[2J\x1b[H› 历史用户输入\r\nSelect a model\r\nGPT-6");
    outbound.length = 0;
    adapter.scrollToTop();
    adapter.scrollToBottom();
    expect(outbound).toEqual([]);
  });

  it("新版键盘上下键和 Ctrl + Home/End 保留原始导航编码", async () => {
    await renderTerminal("\x1b[?1049h\x1b[?1003h\x1b[20;1H› Ask Codex to do anything");
    outbound.length = 0;
    pressKey("ArrowUp", 38);
    pressKey("ArrowDown", 40);
    pressKey("Home", 36, { ctrlKey: true });
    pressKey("End", 35, { ctrlKey: true });
    expect(outbound).toEqual(["\x1b[A", "\x1b[B", "\x1b[1;5H", "\x1b[1;5F"]);
  });

  it("Codex 的 Alt + ↑ 只发送一次 Alt 编码，且阻止浏览器默认动作", () => {
    const event = pressKey("ArrowUp", 38, { altKey: true });

    expect(outbound).toEqual(["\x1b[1;3A"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(["shell", "claude", "gemini", ""])("%s 标签页保留 xterm 原有的 Alt + ↑ 行为", (provider) => {
    providerId = provider;

    pressKey("ArrowUp", 38, { altKey: true });

    expect(outbound).toEqual(["\x1b[1;5A"]);
  });

  it.each([
    ["ArrowUp", 38, {}, "\x1b[A"],
    ["ArrowUp", 38, { ctrlKey: true }, "\x1b[1;5A"],
    ["ArrowUp", 38, { altKey: true, shiftKey: true }, "\x1b[1;4A"],
    ["ArrowUp", 38, { altKey: true, ctrlKey: true }, "\x1b[1;7A"],
    ["ArrowDown", 40, { altKey: true }, "\x1b[1;5B"],
    ["ArrowLeft", 37, { altKey: true }, "\x1b[1;5D"],
    ["ArrowRight", 39, { altKey: true }, "\x1b[1;5C"],
    ["Enter", 13, {}, "\r"],
    ["Escape", 27, {}, "\x1b"],
    ["c", 67, { ctrlKey: true }, "\x03"],
  ] as const)("保留 %s / %j / %j 的原有编码", (key, keyCode, modifiers, expected) => {
    pressKey(key, keyCode, modifiers);

    expect(outbound).toEqual([expected]);
  });

  it("输入法组合期间不注入 Codex 回答快捷键", () => {
    pressKey("ArrowUp", 229, { altKey: true, isComposing: true });

    expect(outbound).toEqual([]);
  });

  it("按键时读取最新引擎，切换后立即恢复默认行为", () => {
    pressKey("ArrowUp", 38, { altKey: true });
    providerId = "shell";
    pressKey("ArrowUp", 38, { altKey: true });

    expect(outbound).toEqual(["\x1b[1;3A", "\x1b[1;5A"]);
  });

  it("Ctrl + V 仍只粘贴一次剪贴板内容", async () => {
    vi.spyOn(clipboard, "readTextCrossPlatform").mockResolvedValue("example text");

    pressKey("v", 86, { ctrlKey: true });

    await vi.waitFor(() => expect(outbound).toEqual(["example text"]));
  });

  it("输入焦点在页面其他输入框时不发送快捷键", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp", keyCode: 38, altKey: true, bubbles: true, cancelable: true,
    }));

    expect(outbound).toEqual([]);
  });

  it("按下 Alt 的矩形选区提示仍然生效，松开后恢复", () => {
    const terminal = textarea.closest(".xterm")!;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", keyCode: 18, altKey: true, bubbles: true }));
    expect(terminal.classList.contains("column-select")).toBe(true);

    textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", keyCode: 18, bubbles: true }));
    expect(terminal.classList.contains("column-select")).toBe(false);
    expect(outbound).toEqual([]);
  });
});
