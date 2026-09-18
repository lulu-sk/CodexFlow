import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  GEMINI_PASTE_ENTER_DELAY_MS,
  buildBracketedPastePayload,
  getPasteEnterDelayMs,
  getPasteSubmitMinWaitMs,
  stripTrailingNewlines,
  writeBracketedPaste,
  writeBracketedPasteAndEnter,
} from "./terminal-send";

describe("terminal-send（Bracketed Paste / Gemini 发送策略）", () => {
  afterEach(() => {
    try { vi.useRealTimers(); } catch {}
  });

  it("stripTrailingNewlines 仅移除末尾连续 CR/LF", () => {
    expect(stripTrailingNewlines("a\nb\n")).toBe("a\nb");
    expect(stripTrailingNewlines("a\r\nb\r\n")).toBe("a\r\nb");
    expect(stripTrailingNewlines("a\r\n\n\r\n")).toBe("a");
    expect(stripTrailingNewlines("a\nb")).toBe("a\nb");
  });

  it("buildBracketedPastePayload 构造 ESC[200~...ESC[201~", () => {
    expect(buildBracketedPastePayload("hello")).toBe(`${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`);
  });

  it.each(["pwsh", "windows", "cmd"] as const)("Codex %s 的正文换行编码为 Alt+Enter，保留空行、缩进和非 ASCII 字符", (terminalMode) => {
    const text = "你好\r\n\r\n  牛号\n\t第三行😀\r尾行\n";
    expect(buildBracketedPastePayload(text, { providerId: " CODEX ", terminalMode }))
      .toBe(`${BRACKETED_PASTE_START}你好\x1b\r\x1b\r  牛号\x1b\r\t第三行😀\x1b\r尾行\x1b\r${BRACKETED_PASTE_END}`);
  });

  it.each([
    { providerId: "codex", terminalMode: "wsl" as const },
    { providerId: "codex" },
    { providerId: "claude", terminalMode: "pwsh" as const },
    { providerId: "gemini", terminalMode: "pwsh" as const },
    { providerId: "antigravity", terminalMode: "pwsh" as const },
    { providerId: "grok", terminalMode: "cmd" as const },
    { terminalMode: "pwsh" as const },
  ])("其他环境不注入 Codex Windows 换行按键：%j", (options) => {
    const text = "第一行\r\n第二行\n\n第三行\r";
    expect(buildBracketedPastePayload(text, options))
      .toBe(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
  });

  it("Codex Windows 单行内容保持原样", () => {
    expect(buildBracketedPastePayload("hello 世界😀", { providerId: "codex", terminalMode: "pwsh" }))
      .toBe(`${BRACKETED_PASTE_START}hello 世界😀${BRACKETED_PASTE_END}`);
  });

  it("Codex Windows 兜底仅写入保留末尾空行，提交则只追加一次延迟 Enter", () => {
    vi.useFakeTimers();
    const options = { providerId: "codex", terminalMode: "pwsh" as const };
    const writes: string[] = [];
    writeBracketedPaste((data) => writes.push(data), "你好\n牛号\n你好\n", options);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}你好\x1b\r牛号\x1b\r你好\x1b\r${BRACKETED_PASTE_END}`]);
    vi.runAllTimers();
    expect(writes).toHaveLength(1);

    writes.length = 0;
    writeBracketedPasteAndEnter((data) => writes.push(data), "你好\n牛号\n你好\n", options);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}你好\x1b\r牛号\x1b\r你好${BRACKETED_PASTE_END}`]);
    const delay = getPasteSubmitMinWaitMs({ ...options, textLength: "你好\n牛号\n你好".length });
    vi.advanceTimersByTime(delay - 1);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(writes[1]).toBe("\r");
    vi.runAllTimers();
    expect(writes).toHaveLength(2);
  });

  it("getPasteEnterDelayMs：Gemini 类 Provider 返回固定延迟，其它返回 0", () => {
    expect(getPasteEnterDelayMs("gemini")).toBe(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(getPasteEnterDelayMs("GEMINI")).toBe(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(getPasteEnterDelayMs("antigravity")).toBe(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(getPasteEnterDelayMs("grok")).toBe(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(getPasteEnterDelayMs("codex")).toBe(0);
    expect(getPasteEnterDelayMs("claude")).toBe(0);
    expect(getPasteEnterDelayMs("unknown")).toBe(0);
  });

  it("getPasteSubmitMinWaitMs：Gemini 与 Windows/Pwsh 下的 Codex / Claude 会按长度返回保守等待时间", () => {
    expect(getPasteSubmitMinWaitMs({ providerId: "claude", terminalMode: "wsl", textLength: 12000 })).toBe(0);
    expect(getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode: "wsl", textLength: 12000 })).toBe(0);
    expect(getPasteSubmitMinWaitMs({ providerId: "gemini", terminalMode: "pwsh", textLength: 512 })).toBeGreaterThan(0);
    expect(getPasteSubmitMinWaitMs({ providerId: "antigravity", terminalMode: "pwsh", textLength: 512 })).toBeGreaterThan(0);
    expect(getPasteSubmitMinWaitMs({ providerId: "grok", terminalMode: "pwsh", textLength: 512 })).toBeGreaterThan(0);
    expect(getPasteSubmitMinWaitMs({ providerId: "claude", terminalMode: "pwsh", textLength: 512 })).toBeGreaterThan(0);
    expect(getPasteSubmitMinWaitMs({ providerId: "claude", terminalMode: "pwsh", textLength: 12000 }))
      .toBeGreaterThan(getPasteSubmitMinWaitMs({ providerId: "claude", terminalMode: "pwsh", textLength: 512 }));
    expect(getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode: "pwsh", textLength: 12000 }))
      .toBeGreaterThan(getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode: "pwsh", textLength: 512 }));
  });

  it("writeBracketedPaste 会写入一次 bracketed paste 序列", () => {
    const writes: string[] = [];
    writeBracketedPaste((d) => writes.push(d), "a\nb");
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
  });

  it("writeBracketedPasteAndEnter：Gemini 类 Provider 延迟回车（避开 40ms 防误触窗口）", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    writeBracketedPasteAndEnter((d) => writes.push(d), "a\nb\n", { providerId: "gemini" });

    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS - 1);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`, "\r"]);
  });

  it("writeBracketedPasteAndEnter：Antigravity 复用 Gemini 类延迟回车", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    writeBracketedPasteAndEnter((d) => writes.push(d), "a\nb\n", { providerId: "antigravity" });

    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`, "\r"]);
  });

  it("writeBracketedPasteAndEnter：Grok 复用 Gemini 类延迟回车", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    writeBracketedPasteAndEnter((d) => writes.push(d), "a\nb\n", { providerId: "grok" });

    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`, "\r"]);
  });

  it("writeBracketedPasteAndEnter：非 Gemini 立即回车", () => {
    const writes: string[] = [];
    writeBracketedPasteAndEnter((d) => writes.push(d), "hi\n", { providerId: "codex" });
    expect(writes).toEqual([`${BRACKETED_PASTE_START}hi${BRACKETED_PASTE_END}`, "\r"]);
  });
});

