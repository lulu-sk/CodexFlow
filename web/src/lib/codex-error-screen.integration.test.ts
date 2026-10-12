// @vitest-environment jsdom

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// 此联测只用真实终端解析器；关闭 jsdom 不支持的画布能力探测，不替换终端写入或缓冲区。
const canvasProbe = vi.hoisted(() => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null));

import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { classifyCodexCliErrorText, detectCodexCliRuntimeStatusOnScreen } from "./codex-cli-error-classifier";
import { createCodexTurnCompletionProbe, inspectCodexTurnCompletion } from "./codex-turn-completion";
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
  it.each([40, 80, 128])("%i 列中状态栏从重连局部重画为压缩后，实际屏幕应恢复工作中", async (cols) => {
    const terminal = createTerminal(cols);
    const reconnect = "• Reconnecting... 1/5 (56s • esc to interrupt)";
    const compact = "• Compacting context (45s • esc to interrupt)";
    const reconnectLine = reconnect.length > cols ? reconnect.slice(0, cols - 1) + "…" : reconnect;
    const compactLine = compact.length > cols ? compact.slice(0, cols - 1) + "…" : compact;
    await writeTerminal(terminal, `\x1b[?1049h\x1b[H\x1b[2J› continue\x1b[3;1H${reconnectLine}\x1b[4;1H  stream disconnected before completion\x1b[6;1H› Ask Codex to do anything`);
    expect(detectCodexCliRuntimeStatusOnScreen(readScreen(terminal))?.phase).toBe("reconnecting");
    await writeTerminal(terminal, `\x1b[?2026h\x1b[3;1H\x1b[2K${compactLine}\x1b[4;1H\x1b[2K  Making room to continue.\x1b[6;3H\x1b[?2026l`);
    expect(detectCodexCliRuntimeStatusOnScreen(readScreen(terminal))?.phase).toBe("working");
  });

  it.each([40, 80, 128])("%i 列中提示词自行折行时，真实活动到完成画面仍能收敛", async (cols) => {
    const terminal = createTerminal(cols);
    const prompt = "检查当前问题并修复所有已确认的问题".repeat(6);
    await writeTerminal(terminal, "\x1b[?1049h\x1b[?1003h\x1b[?1006h");
    // 按行定位模拟 Codex 自己的折行，真实缓冲区不会将这些行标成 isWrapped。
    const rows = ["› 检查当前问题并修复所有已确认的问题", "  检查当前问题并修复所有已确认的问题", "• Working (1s • esc to interrupt)", "", "› Ask Codex to do anything"];
    await writeTerminal(terminal, `\x1b[?2026h\x1b[H\x1b[2J${rows.map((line, index) => `\x1b[${index + 1};1H${line}`).join("")}\x1b[5;3H\x1b[?2026l`);
    const active = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), readScreen(terminal), prompt, false, 0);
    expect(active.probe.boundaryPrompt).toBeUndefined();
    expect(active.probe.activityObserved).toBe(true);
    await writeTerminal(terminal, "\x1b[?2026h\x1b[H\x1b[2J• 已完成检查。\x1b[3;1HWorked for 17m 19s • 02:58\x1b[5;1H› Ask Codex to do anything\x1b[5;3H\x1b[?2026l");
    const screen = readScreen(terminal);
    const first = inspectCodexTurnCompletion(active.probe, screen, prompt, false, 1000);
    expect(first.completed).toBe(false);
    expect(inspectCodexTurnCompletion(first.probe, screen, prompt, false, 2000).completed).toBe(true);
    const browsing = `${screen}\nenter/esc latest`;
    expect(inspectCodexTurnCompletion(first.probe, browsing, prompt, false, 2000).completed).toBe(false);
  });

  it.each([80, 128])("%i 列中 Codex 自行折行的最终 502 应结束旧重连，历史重画仍不重复处理", async (cols) => {
    const terminal = createTerminal(cols);
    const error = "unexpected status 502 Bad Gateway: Upstream service temporarily unavailable";
    const reconnect = classifyCodexCliErrorText(`Reconnecting... 1/5\n${error}`)!;
    let handledErrors = rememberCodexErrorReplay([], reconnect, 1);
    expect(reconnect.phase).toBe("reconnecting");
    await writeTerminal(terminal, "\x1b[?1049h\x1b[?1003h\x1b[?1006h");

    // Codex 按行定位绘制；这些续行不是 xterm 自动折行，不能依赖 isWrapped 合并。
    const rows = [
      "› 检查当前问题",
      `■ ${error},`,
      "url: https://example.test/v1/responses, request",
      "id: sample-request",
      "",
      "› Ask Codex to do anything",
      "GPT-6 · Context 36% left · Fast off",
      "? for shortcuts",
    ];
    const finalFrame = `\x1b[?2026h\x1b[H\x1b[2J\x1b[31m${rows.map((line, index) => `\x1b[${index + 1};1H${line}`).join("")}\x1b[0m\x1b[6;3H\x1b[?2026l`;
    const frame = consumeCodexPtyOutputChunk(createCodexPtyOutputFrameState(), finalFrame).frames[0];
    await writeTerminal(terminal, finalFrame);
    expect(terminal.buffer.active.getLine(3)?.isWrapped).toBe(false);
    const candidate = classifyCodexCliErrorText(frame.text)!;
    expect(candidate).toMatchObject({ kind: "badGateway", phase: "final" });
    const screen = readScreen(terminal);
    const confirmed = classifyCodexFinalErrorOnIdleScreen(screen, "检查当前问题")!;
    expect(confirmed).toMatchObject({ kind: "badGateway", phase: "final", explicitFinal: true });
    const check = {
      historyReplay: false, synchronized: true, resizeReplayActive: false,
      currentTurn: 1, currentPrompt: "检查当前问题", classification: confirmed,
      outputText: screen, idleScreenConfirmed: true, handledErrors,
    };
    expect(resolveCodexErrorReplayDecision(check)).toBe("allow");
    handledErrors = rememberCodexErrorReplay(handledErrors, confirmed, 1);
    expect(resolveCodexErrorReplayDecision({ ...check, handledErrors })).toBe("suppress");
    expect(resolveCodexErrorReplayDecision({
      ...check, handledErrors, historyReplay: true, resizeReplayActive: true,
    })).toBe("suppress");
  });

  it.each([80, 128])("%i 列新版历史视图保留输入框时，旧错误不能通过稳定屏幕确认", async (cols) => {
    const terminal = createTerminal(cols);
    const error = "unexpected status 502 Bad Gateway: upstream unavailable";
    await writeTerminal(terminal, `\x1b[?1049h\x1b[?1003h\x1b[?1006h`);
    const historical = `\x1b[?2026h\x1b[H\x1b[2J■ ${error}\r\n\r\n› Ask Codex to do anything\r\nGPT-6 · Context 35% left\r\nenter/esc latest\x1b[?2026l`;
    await writeTerminal(terminal, historical);
    const screen = readScreen(terminal);
    expect(terminal.buffer.active.type).toBe("alternate");
    expect(classifyCodexFinalErrorOnIdleScreen(screen, "检查当前问题")).toBeNull();

    // 滚轮重画可能只发送旧错误，输入框下方的浏览提示保留在原屏幕上。
    const redraw = `\x1b[?2026h\x1b[1;3H${error}\x1b[3;3H\x1b[?2026l`;
    const frame = consumeCodexPtyOutputChunk(createCodexPtyOutputFrameState(), redraw).frames[0];
    expect(frame.historyReplay).toBe(false);
    const candidate = classifyCodexCliErrorText(frame.text)!;
    expect(candidate).toMatchObject({ kind: "badGateway", phase: "final" });
    await writeTerminal(terminal, redraw);
    expect(classifyCodexFinalErrorOnIdleScreen(readScreen(terminal), "检查当前问题")).toBeNull();

    // 返回最新画面后，相同错误再次真实发生，仍能确认且只处理一次。
    await writeTerminal(terminal, `\x1b[H\x1b[2J› 检查当前问题\r\n■ ${error}\r\n\r\n› Ask Codex to do anything\r\nGPT-6 · Context 35% left`);
    const currentScreen = readScreen(terminal);
    const confirmed = classifyCodexFinalErrorOnIdleScreen(currentScreen, "检查当前问题")!;
    expect(confirmed).toMatchObject({ kind: "badGateway", phase: "final" });
    const check = {
      historyReplay: false, synchronized: true, resizeReplayActive: false,
      currentTurn: 2, currentPrompt: "检查当前问题", classification: confirmed,
      outputText: currentScreen, idleScreenConfirmed: true, handledErrors: undefined,
    };
    expect(resolveCodexErrorReplayDecision(check)).toBe("allow");
    expect(resolveCodexErrorReplayDecision({
      ...check, handledErrors: rememberCodexErrorReplay([], confirmed, 2),
    })).toBe("suppress");
  });

  it.each([80, 128])("%i 列中旧 502 正文的局部重画必须等待屏幕确认，新一轮真实 502 仍可处理", async (cols) => {
    const terminal = createTerminal(cols);
    const error = "unexpected status 502 Bad Gateway: Upstream service temporarily unavailable, url: https://example.test/v1/responses, request id: sample-request";
    await writeTerminal(terminal, [
      `■ ${error}`,
      "",
      "› 继续",
      "",
      "• 继续。保持现有运行和成果，稍后检查。",
      BACKGROUND_FOOTER,
      "",
      "› Ask Codex to do anything",
    ].join("\r\n"));
    expect(classifyCodexFinalErrorOnIdleScreen(readScreen(terminal), "继续")).toBeNull();

    // 只重画错误正文，方块和新轮次输入仍留在屏幕上；字节顺序不等于屏幕顺序。
    for (const synchronized of [false, true]) {
      const redraw = `\x1b[1;3H\x1b[31m${error}\x1b[0m`;
      const text = synchronized ? `\x1b[?2026h${redraw}\x1b[?2026l` : redraw;
      const frames = consumeCodexPtyOutputChunk(createCodexPtyOutputFrameState(), text).frames;
      await writeTerminal(terminal, text);
      const candidate = classifyCodexCliErrorText(frames[0].text)!;
      expect(candidate).toMatchObject({ kind: "badGateway", phase: "final" });
      expect(candidate.explicitFinal).not.toBe(true);
      const check = {
        historyReplay: frames[0].historyReplay,
        synchronized: frames[0].synchronized,
        resizeReplayActive: false,
        currentTurn: 1,
        currentPrompt: "继续",
        handledErrors: undefined,
        classification: candidate,
        outputText: frames[0].text,
      };
      expect(resolveCodexErrorReplayDecision(check)).toBe("await-idle");
      expect(classifyCodexFinalErrorOnIdleScreen(readScreen(terminal), "继续")).toBeNull();
    }

    // 同样的无标记候选对应真正的新错误时，完整屏幕仍应放行一次。
    await writeTerminal(terminal, `\x1b[2J\x1b[H› 继续\r\n■ ${error}\r\n${BACKGROUND_FOOTER}\r\n\r\n› Ask Codex to do anything`);
    const screen = readScreen(terminal);
    const confirmed = classifyCodexFinalErrorOnIdleScreen(screen, "继续")!;
    expect(confirmed).toMatchObject({ kind: "badGateway", explicitFinal: true });
    const confirmedCheck = {
      historyReplay: false,
      synchronized: true,
      resizeReplayActive: false,
      currentTurn: 1,
      currentPrompt: "继续",
      handledErrors: undefined,
      classification: confirmed,
      outputText: screen,
      idleScreenConfirmed: true,
    };
    expect(resolveCodexErrorReplayDecision(confirmedCheck)).toBe("allow");
    expect(resolveCodexErrorReplayDecision({
      ...confirmedCheck,
      handledErrors: rememberCodexErrorReplay([], confirmed, 1),
    })).toBe("suppress");
  });

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
