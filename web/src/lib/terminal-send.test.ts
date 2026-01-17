import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  GEMINI_PASTE_ENTER_DELAY_MS,
  buildBracketedPastePayload,
  getPasteEnterDelayMs,
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

  it("getPasteEnterDelayMs：Gemini 返回固定延迟，其它返回 0", () => {
    expect(getPasteEnterDelayMs("gemini")).toBe(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(getPasteEnterDelayMs("GEMINI")).toBe(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(getPasteEnterDelayMs("codex")).toBe(0);
    expect(getPasteEnterDelayMs("claude")).toBe(0);
    expect(getPasteEnterDelayMs("unknown")).toBe(0);
  });

  it("writeBracketedPaste 会写入一次 bracketed paste 序列", () => {
    const writes: string[] = [];
    writeBracketedPaste((d) => writes.push(d), "a\nb");
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
  });

  it("writeBracketedPasteAndEnter：Gemini 延迟回车（避开 40ms 防误触窗口）", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    writeBracketedPasteAndEnter((d) => writes.push(d), "a\nb\n", { providerId: "gemini" });

    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS - 1);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`, "\r"]);
  });

  it("writeBracketedPasteAndEnter：非 Gemini 立即回车", () => {
    const writes: string[] = [];
    writeBracketedPasteAndEnter((d) => writes.push(d), "hi\n", { providerId: "codex" });
    expect(writes).toEqual([`${BRACKETED_PASTE_START}hi${BRACKETED_PASTE_END}`, "\r"]);
  });
});

