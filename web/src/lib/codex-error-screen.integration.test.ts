// @vitest-environment jsdom

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// 此联测只用真实终端解析器；关闭 jsdom 不支持的画布能力探测，不替换终端写入或缓冲区。
const canvasProbe = vi.hoisted(() => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null));

import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { classifyCodexCliErrorText } from "./codex-cli-error-classifier";
import {
  classifyCodexFinalErrorOnIdleScreen,
  consumeCodexPtyOutputChunk,
  createCodexPtyOutputFrameState,
  rememberCodexErrorReplay,
  resolveCodexErrorReplayDecision,
} from "./codex-error-replay-guard";

const terminals: Terminal[] = [];
const CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";
const BACKGROUND_FOOTER = "  1 background terminal running · /ps to view · /stop to close";

afterAll(() => canvasProbe.mockRestore());

afterEach(() => {
  for (const terminal of terminals) terminal.dispose();
  terminals.length = 0;
});

/** 创建真实 xterm 解析器，使用与应用相同的 Unicode 版本；无需打开图形窗口。 */
function createTerminal(cols: number): Terminal {
  const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  terminals.push(terminal);
  return terminal;
}

/** 等待真实 xterm 消费完本次字节，屏幕确认只能读取写入回调之后的缓冲区。 */
async function writeTerminal(terminal: Terminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(text, resolve));
}

/** 合并 xterm 的自动折行，保留终端显式换行，用于验证状态机实际读取的逻辑屏幕。 */
function readScreen(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  let text = "";
  for (let index = 0; index < buffer.length; index++) {
    const nextWrapped = !!buffer.getLine(index + 1)?.isWrapped;
    text += buffer.getLine(index)?.translateToString(!nextWrapped) || "";
    if (!nextWrapped) text += "\n";
  }
  return text;
}

describe("Codex 错误字节流与真实终端屏幕联测", () => {
  it.each([80, 128])("%i 列终端中紧排容量警告与后台终端栏均可确认，重绘不重复处理", async (cols) => {
    const terminal = createTerminal(cols);
    const error = `Error running remote compact task: ${CAPACITY_MESSAGE}`;
    // 光标定位使符号与正文相邻；错误候选帧和输入框帧分开发送，覆盖实际的增量绘制入口。
    const errorFrame = `\x1b[?2026h› 继续\r\n\x1b[33m⚠\x1b[2G${error}\x1b[0m\r\n\x1b[?2026l`;
    const composerFrame = `\x1b[?2026h${BACKGROUND_FOOTER}\r\n\r\n› Ask Codex to do anything\x1b[?2026l`;
    let frameState = createCodexPtyOutputFrameState();
    const frames = [];
    for (let offset = 0; offset < errorFrame.length; offset += 7) {
      const chunk = errorFrame.slice(offset, offset + 7);
      const result = consumeCodexPtyOutputChunk(frameState, chunk);
      frameState = result.state;
      frames.push(...result.frames);
      await writeTerminal(terminal, chunk);
    }
    expect(frames).toHaveLength(1);
    const candidate = classifyCodexCliErrorText(frames[0].text)!;
    expect(candidate).toMatchObject({ kind: "modelCapacity", explicitFinal: true });
    const check = {
      historyReplay: false,
      synchronized: true,
      resizeReplayActive: false,
      currentTurn: 1,
      currentPrompt: "继续",
      handledErrors: undefined,
      classification: candidate,
      outputText: frames[0].text,
    };
    expect(resolveCodexErrorReplayDecision(check)).toBe("await-idle");
    expect(classifyCodexFinalErrorOnIdleScreen(readScreen(terminal), "继续")).toBeNull();

    await writeTerminal(terminal, composerFrame);
    const screen = readScreen(terminal);
    expect(screen).toContain(`⚠${error}`);
    const confirmed = classifyCodexFinalErrorOnIdleScreen(screen, "继续")!;
    expect(confirmed).toMatchObject({ kind: "modelCapacity", phase: "final" });
    expect(resolveCodexErrorReplayDecision({
      ...check, classification: confirmed, outputText: screen, idleScreenConfirmed: true,
    })).toBe("allow");

    const handledErrors = rememberCodexErrorReplay([], confirmed, 1);
    terminal.resize(cols + 8, 24);
    expect(resolveCodexErrorReplayDecision({
      ...check, classification: confirmed, outputText: readScreen(terminal),
      historyReplay: true, resizeReplayActive: true, handledErrors, idleScreenConfirmed: true,
    })).toBe("suppress");
  });

  it("已恢复运行时即使保留旧容量警告、后台栏和输入框，也不能确认失败", async () => {
    const terminal = createTerminal(128);
    await writeTerminal(terminal, [
      "› 继续",
      `⚠${CAPACITY_MESSAGE}`,
      "Working (1m 03s  esc to interrupt)",
      BACKGROUND_FOOTER,
      "",
      "› Ask Codex to do anything",
    ].join("\r\n"));
    expect(classifyCodexFinalErrorOnIdleScreen(readScreen(terminal), "继续")).toBeNull();
  });
});
