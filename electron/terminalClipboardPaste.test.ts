import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalClipboardPasteManager } from "./terminalClipboardPaste";

/** 使用独立剪贴板桩验证恢复、并发和用户复制，不接触系统剪贴板。 */
function createClipboard() {
  let text = "原有文本";
  const image = {} as any;
  const clipboard = {
    availableFormats: vi.fn(() => ["text/plain", "text/html", "image/png"]),
    readText: vi.fn(() => text),
    readHTML: vi.fn(() => "<b>原有文本</b>"),
    readRTF: vi.fn(() => "{\\rtf1 example}"),
    readImage: vi.fn(() => image),
    readBookmark: vi.fn(() => ({ title: "", url: "" })),
    writeText: vi.fn((value: string) => { text = value; }),
    write: vi.fn((snapshot: { text?: string }) => { text = snapshot.text || ""; }),
  };
  return { clipboard, manager: new TerminalClipboardPasteManager(clipboard) };
}

describe("终端原生粘贴的剪贴板租借", () => {
  afterEach(() => vi.useRealTimers());

  it("完整恢复原有文本、富文本和图片，正文保持原样", () => {
    const { clipboard, manager } = createClipboard();
    const text = "日志😀\r\n\r\n  尾行\t".repeat(15000);
    const result = manager.begin("pty-example", text);
    expect(result.ok).toBe(true);
    expect(clipboard.readText()).toBe(text);
    expect(manager.finish("pty-example", result.token!)).toEqual({ ok: true });
    expect(clipboard.write).toHaveBeenCalledWith({ text: "原有文本", html: "<b>原有文本</b>", rtf: "{\\rtf1 example}", image: clipboard.readImage(), bookmark: "" });
    expect(clipboard.readText()).toBe("原有文本");
  });

  it("并发请求与错误终端或令牌不能抢占租借", () => {
    const { clipboard, manager } = createClipboard();
    const lease = manager.begin("pty-first", "待粘贴正文");
    expect(manager.begin("pty-second", "另一段正文").ok).toBe(false);
    expect(manager.finish("pty-second", lease.token!).ok).toBe(false);
    expect(manager.finish("pty-first", "wrong-token").ok).toBe(false);
    expect(clipboard.readText()).toBe("待粘贴正文");
    manager.dispose();
    expect(clipboard.readText()).toBe("原有文本");
  });

  it("用户在粘贴期间复制新内容时保留新内容，拒绝确认发送", () => {
    const { clipboard, manager } = createClipboard();
    const lease = manager.begin("pty-example", "待粘贴正文");
    clipboard.writeText("用户新复制内容");
    expect(manager.finish("pty-example", lease.token!)).toEqual({ ok: false, error: "clipboard-changed" });
    expect(clipboard.readText()).toBe("用户新复制内容");
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("渲染进程没有释放时自动恢复，过期令牌不能干扰后续粘贴", () => {
    vi.useFakeTimers();
    const { clipboard, manager } = createClipboard();
    const first = manager.begin("pty-example", "正文");
    vi.advanceTimersByTime(10000);
    expect(clipboard.readText()).toBe("原有文本");
    const second = manager.begin("pty-example", "后续正文");
    expect(manager.finish("pty-example", first.token!).ok).toBe(false);
    expect(clipboard.readText()).toBe("后续正文");
    expect(manager.finish("pty-example", second.token!).ok).toBe(true);
  });

  it("不可恢复的剪贴板格式与无效正文不产生写入", () => {
    const { clipboard, manager } = createClipboard();
    clipboard.availableFormats.mockReturnValue(["application/example-private-format"]);
    expect(manager.begin("pty-example", "正文").ok).toBe(false);
    expect(manager.begin("pty-example", "").ok).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.write).not.toHaveBeenCalled();
  });
});
