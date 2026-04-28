// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  GEMINI_PASTE_ENTER_DELAY_MS,
  getPasteSubmitMinWaitMs,
} from "./terminal-send";

const createTerminalAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/TerminalAdapter", () => ({
  createTerminalAdapter: createTerminalAdapterMock,
}));

import TerminalManager from "./TerminalManager";

describe("TerminalManager（长文本发送策略）", () => {
  afterEach(() => {
    try { vi.useRealTimers(); } catch {}
    try { createTerminalAdapterMock.mockReset(); } catch {}
    try { delete (window as any).host; } catch {}
  });

  /**
   * 中文说明：创建带事件分发能力的 hostPty stub，便于模拟 PTY 输出回显。
   */
  const createHostPtyStub = () => {
    const dataHandlersById = new Map<string, Set<(data: string) => void>>();
    const write = vi.fn();
    return {
      write,
      resize: vi.fn(),
      close: vi.fn(),
      onData: (id: string, handler: (data: string) => void) => {
        let handlers = dataHandlersById.get(id);
        if (!handlers) {
          handlers = new Set();
          dataHandlersById.set(id, handlers);
        }
        handlers.add(handler);
        return () => {
          const current = dataHandlersById.get(id);
          if (!current) return;
          current.delete(handler);
          if (current.size === 0) dataHandlersById.delete(id);
        };
      },
      emitData: (id: string, data: string) => {
        const handlers = dataHandlersById.get(id);
        if (!handlers) return;
        [...handlers].forEach((handler) => handler(data));
      },
    };
  };

  /**
   * 中文说明：创建最小可用的终端适配器 stub，避免单测依赖真实 xterm。
   */
  const createAdapterStub = () => {
    return {
      mount: vi.fn(() => ({ cols: 80, rows: 24 })),
      write: vi.fn(),
      paste: vi.fn(),
      onData: vi.fn(() => () => {}),
      resize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getScrollSnapshot: vi.fn(() => null),
      restoreScrollSnapshot: vi.fn(),
      readCursorTextSnapshot: vi.fn(() => null),
      focus: vi.fn(),
      blur: vi.fn(),
      setAppearance: vi.fn(),
      dispose: vi.fn(),
    };
  };

  it("Gemini 会等待 PTY 回显静默后，再延迟发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-gemini": "pty-gemini" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini");
    tm.setPty("tab-gemini", "pty-gemini");

    await tm.sendTextAndEnter("tab-gemini", "第一行\n第二行", { providerId: "gemini" });

    expect(adapter.paste).toHaveBeenCalledWith("第一行\n第二行");
    expect(hostPty.write).not.toHaveBeenCalledWith(
      "pty-gemini",
      `${BRACKETED_PASTE_START}第一行\n第二行${BRACKETED_PASTE_END}`,
    );

    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "gemini", textLength: "第一行\n第二行".length });

    hostPty.emitData("pty-gemini", "第一行");
    vi.advanceTimersByTime(31);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    hostPty.emitData("pty-gemini", "第二行");
    vi.advanceTimersByTime(31);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    const remainMinWaitMs = Math.max(0, minWaitMs - 63);
    if (remainMinWaitMs > 0) {
      vi.advanceTimersByTime(remainMinWaitMs);
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");
    }

    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS - 1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini", "\r");

    tm.disposeAll(false);
  });

  it("Gemini 在 Windows/Pwsh 下会优先走 Ctrl+X 外部编辑器桥接后再发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const readStatus = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: { state: "pending", requestId: "req-win-1" } })
      .mockResolvedValue({ ok: true, status: { state: "done", requestId: "req-win-1" } });
    const writeSource = vi.fn().mockResolvedValue({
      ok: true,
      requestId: "req-win-1",
      sourcePath: "C:\\temp\\source.txt",
      statusPath: "C:\\temp\\status.json",
    });
    (window as any).host = {
      utils: {
        writeGeminiWindowsEditorSource: writeSource,
        readGeminiWindowsEditorStatus: readStatus,
      },
    };

    const ptyByTab: Record<string, string> = { "tab-gemini-win": "pty-gemini-win" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini-win");
    tm.setPty("tab-gemini-win", "pty-gemini-win");

    const text = `${"超长文本".repeat(800)}最后尾巴`;
    await tm.sendTextAndEnter("tab-gemini-win", text, {
      providerId: "gemini",
      terminalMode: "pwsh" as any,
      geminiWindowsEditorReady: true,
    });

    await Promise.resolve();

    expect(writeSource).toHaveBeenCalledWith({ tabId: "tab-gemini-win", content: text });
    expect(adapter.paste).not.toHaveBeenCalled();
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini-win", "\x18");
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-win", "\r");

    await vi.advanceTimersByTimeAsync(40);
    expect(readStatus).toHaveBeenCalledWith({ tabId: "tab-gemini-win" });
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-win", "\r");

    await vi.advanceTimersByTimeAsync(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini-win", "\r");

    tm.disposeAll(false);
  });

  it("Gemini 在 WSL 超长文本命中阈值时会优先走 Ctrl+X 外部编辑器桥接后再发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const readStatus = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: { state: "pending", requestId: "req-wsl-1" } })
      .mockResolvedValue({ ok: true, status: { state: "done", requestId: "req-wsl-1" } });
    const writeSource = vi.fn().mockResolvedValue({
      ok: true,
      requestId: "req-wsl-1",
      sourcePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\.codexflow\\source.txt",
      statusPath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\.codexflow\\status.json",
    });
    (window as any).host = {
      utils: {
        writeGeminiWslEditorSource: writeSource,
        readGeminiWslEditorStatus: readStatus,
      },
    };

    const ptyByTab: Record<string, string> = { "tab-gemini-wsl": "pty-gemini-wsl" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini-wsl");
    tm.setPty("tab-gemini-wsl", "pty-gemini-wsl");

    const text = `${"超长文本".repeat(3000)}最后尾巴`;
    await tm.sendTextAndEnter("tab-gemini-wsl", text, {
      providerId: "gemini",
      terminalMode: "wsl" as any,
      distro: "Ubuntu-24.04",
      geminiWslEditorReady: true,
    });

    await Promise.resolve();

    expect(writeSource).toHaveBeenCalledWith({
      tabId: "tab-gemini-wsl",
      distro: "Ubuntu-24.04",
      content: text,
    });
    expect(adapter.paste).not.toHaveBeenCalled();
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini-wsl", "\x18");
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-wsl", "\r");

    await vi.advanceTimersByTimeAsync(40);
    expect(readStatus).toHaveBeenCalledWith({ tabId: "tab-gemini-wsl", distro: "Ubuntu-24.04" });
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-wsl", "\r");

    await vi.advanceTimersByTimeAsync(GEMINI_PASTE_ENTER_DELAY_MS);
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini-wsl", "\r");

    tm.disposeAll(false);
  });

  it("Gemini 在 WSL 短文本下即使桥接已准备也仍保持原 paste 策略", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const writeSource = vi.fn();
    const readStatus = vi.fn();
    (window as any).host = {
      utils: {
        writeGeminiWslEditorSource: writeSource,
        readGeminiWslEditorStatus: readStatus,
      },
    };

    const ptyByTab: Record<string, string> = { "tab-gemini-wsl-short": "pty-gemini-wsl-short" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini-wsl-short");
    tm.setPty("tab-gemini-wsl-short", "pty-gemini-wsl-short");

    await tm.sendTextAndEnter("tab-gemini-wsl-short", "短文本", {
      providerId: "gemini",
      terminalMode: "wsl" as any,
      distro: "Ubuntu-24.04",
      geminiWslEditorReady: true,
    });

    expect(writeSource).not.toHaveBeenCalled();
    expect(readStatus).not.toHaveBeenCalled();
    expect(adapter.paste).toHaveBeenCalledWith("短文本");

    tm.disposeAll(false);
  });

  it("Gemini 超长文本会以单次连续 paste 会话灌入，并且只会在正文结束后再发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-gemini-huge": "pty-gemini-huge" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini-huge");
    tm.setPty("tab-gemini-huge", "pty-gemini-huge");

    const text = `${"超长文本".repeat(3500)}最后尾巴1234567890`;
    await tm.sendTextAndEnter("tab-gemini-huge", text, {
      providerId: "gemini",
      terminalMode: "pwsh" as any,
    });

    const getPayloadWrites = () =>
      hostPty.write.mock.calls
        .filter((call) => call[0] === "pty-gemini-huge" && call[1] !== "\r")
        .map((call) => String(call[1]));

    expect(adapter.paste).not.toHaveBeenCalled();
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-huge", "\r");

    vi.advanceTimersByTime(200);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-huge", "\r");
    expect(getPayloadWrites().filter((value: string) => value === BRACKETED_PASTE_START)).toHaveLength(1);
    expect(getPayloadWrites().filter((value: string) => value === BRACKETED_PASTE_END)).toHaveLength(0);

    vi.runAllTimers();

    const payloadWrites = getPayloadWrites();
    const startIndex = payloadWrites.indexOf(BRACKETED_PASTE_START);
    const endIndex = payloadWrites.lastIndexOf(BRACKETED_PASTE_END);
    expect(payloadWrites.filter((value: string) => value === BRACKETED_PASTE_START)).toHaveLength(1);
    expect(payloadWrites.filter((value: string) => value === BRACKETED_PASTE_END)).toHaveLength(1);
    expect(startIndex).toBe(0);
    expect(endIndex).toBe(payloadWrites.length - 1);
    expect(payloadWrites.slice(startIndex + 1, endIndex).join("")).toBe(text);
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini-huge", "\r");

    tm.disposeAll(false);
  });

  it("screen-ack 提前命中时，也会等到允许提交且过了最小等待后才发送 Enter", () => {
    vi.useFakeTimers();
    const hostPty = createHostPtyStub();
    const tm = new TerminalManager(() => "pty-screen-ack-gated", hostPty as any, {});

    let allowScreenAckFinish = false;
    const triggerSend = vi.fn();
    const snapshot = {
      bufferType: "alternate" as const,
      cursorAbsY: 24,
      startAbsY: 23,
      endAbsY: 24,
      lines: ["最后尾巴"],
      text: "最后尾巴",
    };

    (tm as any).sendTextAndEnterAfterPtyQuiet("pty-screen-ack-gated", "测试正文", {
      allowQuietSubmit: false,
      providerId: "gemini",
      minWaitMs: 250,
      hardTimeoutMs: 2000,
      screenAckProbe: {
        markers: ["最后尾巴"],
        read: () => ({ matchedMarker: "最后尾巴", snapshot }),
        readSnapshot: () => snapshot,
      },
      screenAckCanFinish: () => allowScreenAckFinish,
      strategy: "screen-ack-gated-test",
      terminalMode: "pwsh",
      triggerSend,
    });

    expect(triggerSend).toHaveBeenCalledWith("测试正文");

    vi.advanceTimersByTime(200);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-screen-ack-gated", "\r");

    allowScreenAckFinish = true;

    vi.advanceTimersByTime(39);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-screen-ack-gated", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-screen-ack-gated", "\r");

    vi.advanceTimersByTime(9);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-screen-ack-gated", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-screen-ack-gated", "\r");

    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS - 1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-screen-ack-gated", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).toHaveBeenCalledWith("pty-screen-ack-gated", "\r");
  });

  it("Codex 在 PowerShell 多行文本场景下，会通过单次 bracketed paste 发送正文并在最小等待后提交", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    let snapshotText = "";
    adapter.readCursorTextSnapshot.mockImplementation(() => {
      if (!snapshotText) return null;
      return {
        bufferType: "alternate",
        cursorAbsY: 22,
        startAbsY: 21,
        endAbsY: 22,
        lines: [snapshotText],
        text: snapshotText,
      };
    });

    const ptyByTab: Record<string, string> = { "tab-codex": "pty-codex" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-codex");
    tm.setPty("tab-codex", "pty-codex");

    const text = [
      "请完成：",
      "1. 检查 Serena、GitNexus、ast-grep 在当前会话是否可用；任一不可用，直接报告并停止。",
      "2. Serena分别检查源仓、当前仓的准备状态；若未完成 onboarding，则完成。若一次只能激活一个项目，请明确说明后续需在两仓间切换。",
      "3. GitNexus检查两仓索引；若缺失或过期，且当前环境可执行 analyze，则先处理；若当前环境不能直接处理，报告“需预处理”并停止。",
      "4. ast-grep确认可直接使用；若仅缺规则配置但不影响基本搜索，标明即可，无需额外初始化。",
      "",
      "最后只输出：三者可用性、源仓准备状态、当前仓准备状态、需预处理项、是否可进入正式任务。",
    ].join("\n");
    await tm.sendTextAndEnter("tab-codex", text, { providerId: "codex", terminalMode: "pwsh" as any });
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode: "pwsh" as any, textLength: text.length });

    expect(adapter.paste).not.toHaveBeenCalled();
    expect(hostPty.write).toHaveBeenCalledWith(
      "pty-codex",
      `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
    );
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex", "\r");

    snapshotText = "最后只输出：三者可用性、源仓准备状态、当前仓准备状态、需预处理项、是否可进入正式任务。";
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex", "\r");

    vi.advanceTimersByTime(40);
    const remainMinWaitMs = Math.max(0, minWaitMs - 80);
    if (remainMinWaitMs > 0) {
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex", "\r");
      vi.advanceTimersByTime(remainMinWaitMs - 1);
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex", "\r");
      vi.advanceTimersByTime(1);
    }
    expect(hostPty.write).toHaveBeenCalledWith("pty-codex", "\r");

    tm.disposeAll(false);
  });

  it("Codex 在 PowerShell 单行文本场景下，仍优先走 adapter.paste", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    let snapshotText = "";
    adapter.readCursorTextSnapshot.mockImplementation(() => {
      if (!snapshotText) return null;
      return {
        bufferType: "alternate",
        cursorAbsY: 22,
        startAbsY: 21,
        endAbsY: 22,
        lines: [snapshotText],
        text: snapshotText,
      };
    });

    const ptyByTab: Record<string, string> = { "tab-codex-single": "pty-codex-single" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-codex-single");
    tm.setPty("tab-codex-single", "pty-codex-single");

    const text = "单行正文不会拆分";
    await tm.sendTextAndEnter("tab-codex-single", text, { providerId: "codex", terminalMode: "pwsh" as any });
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode: "pwsh" as any, textLength: text.length });

    expect(adapter.paste).toHaveBeenCalledWith(text);
    expect(hostPty.write).not.toHaveBeenCalledWith(
      "pty-codex-single",
      `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
    );
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-single", "\r");

    snapshotText = text;
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-single", "\r");

    vi.advanceTimersByTime(40);
    const remainMinWaitMs = Math.max(0, minWaitMs - 80);
    if (remainMinWaitMs > 0) {
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-single", "\r");
      vi.advanceTimersByTime(remainMinWaitMs - 1);
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-single", "\r");
      vi.advanceTimersByTime(1);
    }

    expect(hostPty.write).toHaveBeenCalledWith("pty-codex-single", "\r");

    tm.disposeAll(false);
  });

  it("Codex 在屏幕 ACK 未命中但 PTY 已回显粘贴占位符时，会在最小等待后提交", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    adapter.readCursorTextSnapshot.mockReturnValue(null);

    const ptyByTab: Record<string, string> = { "tab-codex-pty-ack": "pty-codex-pty-ack" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-codex-pty-ack");
    tm.setPty("tab-codex-pty-ack", "pty-codex-pty-ack");

    const text = "x".repeat(1201);
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode: "pwsh" as any, textLength: text.length });
    await tm.sendTextAndEnter("tab-codex-pty-ack", text, { providerId: "codex", terminalMode: "pwsh" as any });

    hostPty.emitData("pty-codex-pty-ack", "[Pasted Content 1.2k chars]");
    vi.advanceTimersByTime(minWaitMs - 1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-pty-ack", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).toHaveBeenCalledWith("pty-codex-pty-ack", "\r");

    tm.disposeAll(false);
  });

  it("Codex 在 PowerShell 多行文本的 write_only 场景下，会通过单次 bracketed paste 写入正文", async () => {
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-codex-write": "pty-codex-write" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-codex-write");
    tm.setPty("tab-codex-write", "pty-codex-write");

    const text = "第一行\n第二行\n第三行";
    await tm.sendText("tab-codex-write", text, { providerId: "codex", terminalMode: "pwsh" as any });

    expect(adapter.paste).not.toHaveBeenCalled();
    expect(hostPty.write).toHaveBeenCalledWith(
      "pty-codex-write",
      `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
    );
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-write", "\r");

    tm.disposeAll(false);
  });

  it("Codex 在 PowerShell 单行文本的 write_only 场景下，仍优先走 adapter.paste", async () => {
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    const ptyByTab: Record<string, string> = { "tab-codex-write-single": "pty-codex-write-single" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-codex-write-single");
    tm.setPty("tab-codex-write-single", "pty-codex-write-single");

    const text = "单行正文";
    await tm.sendText("tab-codex-write-single", text, { providerId: "codex", terminalMode: "pwsh" as any });

    expect(adapter.paste).toHaveBeenCalledWith(text);
    expect(hostPty.write).not.toHaveBeenCalledWith(
      "pty-codex-write-single",
      `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
    );
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-write-single", "\r");

    tm.disposeAll(false);
  });

  it("Claude 在 PowerShell 超长文本场景下，会等待局部屏幕 ACK 后再发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    let snapshotText = "";
    adapter.readCursorTextSnapshot.mockImplementation(() => {
      if (!snapshotText) return null;
      return {
        bufferType: "alternate",
        cursorAbsY: 22,
        startAbsY: 21,
        endAbsY: 22,
        lines: [snapshotText],
        text: snapshotText,
      };
    });

    const ptyByTab: Record<string, string> = { "tab-claude-ack": "pty-claude-ack" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-claude-ack");
    tm.setPty("tab-claude-ack", "pty-claude-ack");

    const text = Array.from({ length: 584 }, (_, index) => `第 ${index + 1} 行`).join("\n");
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "claude", terminalMode: "pwsh" as any, textLength: text.length });
    await tm.sendTextAndEnter("tab-claude-ack", text, { providerId: "claude", terminalMode: "pwsh" as any });

    expect(adapter.paste).toHaveBeenCalledWith(text);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-claude-ack", "\r");

    hostPty.emitData("pty-claude-ack", "Claude 仍在处理粘贴内容");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-claude-ack", "\r");

    snapshotText = "[Pasted text #1 +583 lines]";
    hostPty.emitData("pty-claude-ack", "输入区已显示占位符");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-claude-ack", "\r");

    hostPty.emitData("pty-claude-ack", "Claude 继续刷新状态");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-claude-ack", "\r");

    const remainMinWaitMs = Math.max(0, minWaitMs - 120);
    if (remainMinWaitMs > 0) {
      vi.advanceTimersByTime(remainMinWaitMs - 1);
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-claude-ack", "\r");
      vi.advanceTimersByTime(1);
    }

    expect(hostPty.write).toHaveBeenCalledWith("pty-claude-ack", "\r");

    tm.disposeAll(false);
  });

  it("Gemini 在运行中持续输出时，会等待局部屏幕 ACK 后再发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    let snapshotText = "";
    adapter.readCursorTextSnapshot.mockImplementation(() => {
      if (!snapshotText) return null;
      return {
        bufferType: "alternate",
        cursorAbsY: 23,
        startAbsY: 22,
        endAbsY: 23,
        lines: [snapshotText],
        text: snapshotText,
      };
    });

    const ptyByTab: Record<string, string> = { "tab-gemini-ack": "pty-gemini-ack" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini-ack");
    tm.setPty("tab-gemini-ack", "pty-gemini-ack");

    const text = "1\n2\n3\n4\n5\n6";
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "gemini", textLength: text.length });
    await tm.sendTextAndEnter("tab-gemini-ack", text, { providerId: "gemini" });

    hostPty.emitData("pty-gemini-ack", "模型仍在持续输出");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-ack", "\r");

    snapshotText = "[Pasted Text: 6 lines]";
    hostPty.emitData("pty-gemini-ack", "输出还在继续");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-ack", "\r");

    hostPty.emitData("pty-gemini-ack", "输出继续刷新");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-ack", "\r");

    const remainMinWaitMs = Math.max(0, minWaitMs - 120);
    if (remainMinWaitMs > 0) {
      vi.advanceTimersByTime(remainMinWaitMs);
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-ack", "\r");
    }

    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS - 1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-ack", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini-ack", "\r");

    tm.disposeAll(false);
  });

  it("Gemini 在输入区显示原文尾部而不是占位符时，也会等待局部屏幕 ACK 后再发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    let snapshotText = "";
    adapter.readCursorTextSnapshot.mockImplementation(() => {
      if (!snapshotText) return null;
      return {
        bufferType: "alternate",
        cursorAbsY: 24,
        startAbsY: 23,
        endAbsY: 24,
        lines: snapshotText.split("\n"),
        text: snapshotText,
      };
    });

    const ptyByTab: Record<string, string> = { "tab-gemini-raw-tail": "pty-gemini-raw-tail" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-gemini-raw-tail");
    tm.setPty("tab-gemini-raw-tail", "pty-gemini-raw-tail");

    const text = [
      "第一行背景",
      "第二行背景",
      "第三行背景",
      "第四行背景",
      "第五行背景",
      "最后一行用于 ACK 命中 1234567890",
    ].join("\n");
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "gemini", textLength: text.length });
    await tm.sendTextAndEnter("tab-gemini-raw-tail", text, { providerId: "gemini" });

    hostPty.emitData("pty-gemini-raw-tail", "模型仍在输出");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-raw-tail", "\r");

    snapshotText = "仍在运行\n最后一行用于 ACK 命中 1234567890";
    hostPty.emitData("pty-gemini-raw-tail", "输出继续");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-raw-tail", "\r");

    hostPty.emitData("pty-gemini-raw-tail", "输出继续刷新");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-raw-tail", "\r");

    const remainMinWaitMs = Math.max(0, minWaitMs - 120);
    if (remainMinWaitMs > 0) {
      vi.advanceTimersByTime(remainMinWaitMs);
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-raw-tail", "\r");
    }

    vi.advanceTimersByTime(GEMINI_PASTE_ENTER_DELAY_MS - 1);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-gemini-raw-tail", "\r");

    vi.advanceTimersByTime(1);
    expect(hostPty.write).toHaveBeenCalledWith("pty-gemini-raw-tail", "\r");

    tm.disposeAll(false);
  });

  it("Codex 在运行中持续输出时，会等待局部屏幕 ACK 后再发送 Enter", async () => {
    vi.useFakeTimers();
    const adapter: any = createAdapterStub();
    const hostPty = createHostPtyStub();
    createTerminalAdapterMock.mockReturnValue(adapter);

    let snapshotText = "";
    adapter.readCursorTextSnapshot.mockImplementation(() => {
      if (!snapshotText) return null;
      return {
        bufferType: "alternate",
        cursorAbsY: 22,
        startAbsY: 21,
        endAbsY: 22,
        lines: [snapshotText],
        text: snapshotText,
      };
    });

    const ptyByTab: Record<string, string> = { "tab-codex-ack": "pty-codex-ack" };
    const tm = new TerminalManager((tabId) => ptyByTab[tabId], hostPty as any, {});
    tm.ensurePersistentContainer("tab-codex-ack");
    tm.setPty("tab-codex-ack", "pty-codex-ack");

    const text = "x".repeat(1201);
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode: "pwsh" as any, textLength: text.length });
    await tm.sendTextAndEnter("tab-codex-ack", text, { providerId: "codex", terminalMode: "pwsh" as any });

    hostPty.emitData("pty-codex-ack", "模型持续输出");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-ack", "\r");

    snapshotText = "[Pasted Content 1201 chars]";
    hostPty.emitData("pty-codex-ack", "输出继续");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-ack", "\r");

    hostPty.emitData("pty-codex-ack", "输出继续刷新");
    vi.advanceTimersByTime(40);
    expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-ack", "\r");

    const remainMinWaitMs = Math.max(0, minWaitMs - 120);
    if (remainMinWaitMs > 0) {
      vi.advanceTimersByTime(remainMinWaitMs - 1);
      expect(hostPty.write).not.toHaveBeenCalledWith("pty-codex-ack", "\r");
      vi.advanceTimersByTime(1);
    }

    expect(hostPty.write).toHaveBeenCalledWith("pty-codex-ack", "\r");

    tm.disposeAll(false);
  });
});
