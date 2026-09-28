import { describe, expect, it } from "vitest";
import {
  classifyCodexCliErrorText,
  detectCodexCliRuntimeStatusText,
  type CodexCliErrorClassification,
} from "./codex-cli-error-classifier";
import {
  CODEX_ERROR_REPLAY_HISTORY_LIMIT,
  buildCodexErrorReplayKey,
  classifyCodexFinalErrorOnIdleScreen,
  completeCodexPtyHistoryReplay,
  consumeCodexPtyOutputChunk,
  createCodexPtyOutputFrameState,
  hasCodexComposerPrompt,
  hasCodexCurrentTurnBoundary,
  isCodexFinalErrorVisibleOnIdleScreen,
  isCodexRuntimeStatusAfterError,
  rememberCodexErrorReplay,
  resolveCodexErrorReplayDecision,
  shouldSuppressCodexErrorReplay,
  shouldTrustCodexRuntimeStatusForCurrentTurn,
  type CodexErrorReplayRecord,
  type CodexPtyOutputFrameState,
} from "./codex-error-replay-guard";

const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";
const CLEAR_HISTORY = "\u001b[r\u001b[0m\u001b[H\u001b[2J\u001b[3J\u001b[H";
const ERROR_TEXT = "unexpected status 503 Service Unavailable: openai_error, url: http://example.test/v1/responses";
const RATE_LIMIT_TEXT = "exceeded retry limit, last status: 429 Too Many Requests";
const GENERIC_FINAL_ERROR_TEXTS = [
  "You've hit your usage limit. Try again later.",
  "Selected model is at capacity. Please try a different model.",
  "unexpected status 502 Bad Gateway: upstream unavailable",
  "We're currently experiencing high demand, which may cause temporary errors.",
  "unexpected status 503 Service Unavailable: upstream unavailable",
  "unexpected status 403 Forbidden: access denied",
  "400 Bad Request",
  "unexpected status 413 Payload Too Large",
  "stream disconnected before completion: Concurrency limit exceeded for user, please retry later",
  RATE_LIMIT_TEXT,
  "stream disconnected before completion: network error",
  "unexpected status 520 Unknown Error",
] as const;

const FINAL_ERROR: CodexCliErrorClassification = {
  kind: "serviceUnavailable",
  severity: "temporary",
  retryable: true,
  matchedText: ERROR_TEXT,
  phase: "final",
};

type DetectionHarness = {
  frameState: CodexPtyOutputFrameState;
  handledErrors: CodexErrorReplayRecord[];
  turn: number;
  currentPrompt: string;
  notifications: string[];
  pendingFinal?: {
    classification: CodexCliErrorClassification;
    historyReplay: boolean;
    synchronized: boolean;
    outputText: string;
  };
};

/**
 * 记录测试状态机真正放行的错误。
 */
function recordDetectedError(
  harness: DetectionHarness,
  classification: CodexCliErrorClassification,
): void {
  harness.notifications.push(buildCodexErrorReplayKey(classification));
  harness.handledErrors = rememberCodexErrorReplay(
    harness.handledErrors,
    classification,
    harness.turn,
  );
}

/**
 * 按真实 PTY 分块顺序执行同步帧聚合、错误分类和历史重放去重。
 */
function consumeDetectionSequence(
  harness: DetectionHarness,
  chunks: readonly string[],
  resizeReplayActive = false,
): void {
  for (const chunk of chunks) {
    const result = consumeCodexPtyOutputChunk(harness.frameState, chunk);
    harness.frameState = result.state;
    for (const frame of result.frames) {
      const pendingBeforeFrame = harness.pendingFinal;
      const runtimePhase = detectCodexCliRuntimeStatusText(frame.text)?.phase;
      const classification = classifyCodexCliErrorText(frame.text);
      if (classification) {
        const decision = resolveCodexErrorReplayDecision({
          historyReplay: frame.historyReplay,
          synchronized: frame.synchronized,
          resizeReplayActive,
          handledErrors: harness.handledErrors,
          classification,
          currentTurn: harness.turn,
          currentPrompt: harness.currentPrompt,
          outputText: frame.text,
          currentRuntimePhase: runtimePhase,
        });
        if (decision === "allow") {
          recordDetectedError(harness, classification);
          harness.pendingFinal = undefined;
        } else if (decision === "await-idle") {
          harness.pendingFinal = {
            classification,
            historyReplay: frame.historyReplay,
            synchronized: frame.synchronized,
            outputText: pendingBeforeFrame
              && buildCodexErrorReplayKey(pendingBeforeFrame.classification) === buildCodexErrorReplayKey(classification)
              ? `${pendingBeforeFrame.outputText}\n${frame.text}`
              : frame.text,
          };
        } else {
          harness.pendingFinal = undefined;
        }
      } else if (runtimePhase === "working" || runtimePhase === "reconnecting") {
        harness.pendingFinal = undefined;
      } else if (harness.pendingFinal) {
        harness.pendingFinal.outputText = `${harness.pendingFinal.outputText}\n${frame.text}`;
      }

      if (
        frame.historyReplay
        && !frame.synchronized
        && hasCodexCurrentTurnBoundary(frame.text, harness.currentPrompt)
      ) harness.frameState = completeCodexPtyHistoryReplay(harness.frameState);

      const pending = harness.pendingFinal;
      if (
        !hasCodexComposerPrompt(frame.text)
        || !pending
      ) continue;
      const screenClassification = classifyCodexFinalErrorOnIdleScreen(
        frame.text,
        harness.currentPrompt,
      );
      const confirmDecision = screenClassification
        ? resolveCodexErrorReplayDecision({
          historyReplay: pending.historyReplay,
          synchronized: pending.synchronized,
          resizeReplayActive,
          handledErrors: harness.handledErrors,
          classification: screenClassification,
          currentTurn: harness.turn,
          currentPrompt: harness.currentPrompt,
          outputText: `${pending.outputText}\n${frame.text}`,
          idleScreenConfirmed: true,
        })
        : "suppress";
      harness.pendingFinal = undefined;
      if (confirmDecision === "allow")
        recordDetectedError(harness, screenClassification!);
    }
  }
}

/**
 * 创建一份空的错误识别序列测试状态。
 */
function createDetectionHarness(): DetectionHarness {
  return {
    frameState: createCodexPtyOutputFrameState(),
    handledErrors: [],
    turn: 0,
    currentPrompt: "",
    notifications: [],
  };
}

describe("codex-error-replay-guard（Codex 历史错误重放防护）", () => {
  it("同一错误的重连态与最终态会归为同一特征", () => {
    const reconnectingError = classifyCodexCliErrorText(`
      Reconnecting... 4/5 (2m 10s  esc to interrupt)
        ${ERROR_TEXT}
    `);
    const finalError = classifyCodexCliErrorText(`
      ■ ${ERROR_TEXT}
      › Continue
    `);

    expect(reconnectingError?.phase).toBe("reconnecting");
    expect(finalError?.phase).toBe("final");
    expect(buildCodexErrorReplayKey(reconnectingError!)).toBe(buildCodexErrorReplayKey(finalError!));
  });

  it("同步更新被 PTY 任意分块时只在结束后交付完整帧", () => {
    let state = createCodexPtyOutputFrameState();
    const chunks = [
      `${SYNC_BEGIN.slice(0, 4)}`,
      `${SYNC_BEGIN.slice(4)}■ ${ERROR_TEXT.slice(0, 34)}`,
      `${ERROR_TEXT.slice(34)}\nWorking (1m 03s  esc to interrupt)${SYNC_END.slice(0, 5)}`,
      SYNC_END.slice(5),
    ];
    const frames: string[] = [];

    for (const chunk of chunks) {
      const result = consumeCodexPtyOutputChunk(state, chunk);
      state = result.state;
      frames.push(...result.frames.map((frame) => frame.text));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain(ERROR_TEXT);
    expect(frames[0]).toContain("Working (1m 03s");
    expect(classifyCodexCliErrorText(frames[0])?.explicitFinal).toBe(true);
    expect(state).toEqual(createCodexPtyOutputFrameState());
  });

  it("同步更新缺少结束标记且超出上限时会安全降级，不会卡住后续普通输出", () => {
    const overflow = consumeCodexPtyOutputChunk(
      createCodexPtyOutputFrameState(),
      `${SYNC_BEGIN}${"x".repeat(80)}` ,
      48,
    );

    expect(overflow.frames.some((frame) => frame.synchronized)).toBe(true);
    expect(overflow.state.synchronized).toBe(false);

    const next = consumeCodexPtyOutputChunk(overflow.state, `\n■ ${ERROR_TEXT}`, 48);
    expect(next.frames.some((frame) => frame.text.includes(ERROR_TEXT))).toBe(true);
  });

  it("普通历史回放在看到当前 continue 输入后可以结束回放标记", () => {
    const replay = consumeCodexPtyOutputChunk(
      createCodexPtyOutputFrameState(),
      `${CLEAR_HISTORY}■ ${ERROR_TEXT}\n›\ncontinue\nWorking (1m 03s  esc to interrupt)`,
    );
    const outputText = replay.frames.map((frame) => frame.text).join("");

    expect(replay.frames.some((frame) => frame.historyReplay)).toBe(true);
    expect(hasCodexCurrentTurnBoundary(outputText, "continue")).toBe(true);
    expect(completeCodexPtyHistoryReplay(replay.state).historyReplay).toBe(false);
  });

  it("历史回放的运行状态不能恢复失败任务，缩放期间必须能证明位于本轮输入之后", () => {
    const currentOutput = "› continue\nWorking (1m 03s  esc to interrupt)";

    expect(shouldTrustCodexRuntimeStatusForCurrentTurn({
      historyReplay: true,
      resizeReplayActive: false,
      currentPrompt: "continue",
      outputText: currentOutput,
      statusText: "Working",
    })).toBe(false);
    expect(shouldTrustCodexRuntimeStatusForCurrentTurn({
      historyReplay: false,
      resizeReplayActive: true,
      currentPrompt: "continue",
      outputText: currentOutput,
      statusText: "Working",
    })).toBe(true);
    expect(shouldTrustCodexRuntimeStatusForCurrentTurn({
      historyReplay: false,
      resizeReplayActive: true,
      currentPrompt: "continue",
      outputText: "Working (1m 03s  esc to interrupt)",
      statusText: "Working",
    })).toBe(false);
    expect(shouldTrustCodexRuntimeStatusForCurrentTurn({
      historyReplay: false,
      synchronized: true,
      resizeReplayActive: false,
      currentPrompt: "continue",
      outputText: "Working (1m 03s  esc to interrupt)",
      statusText: "Working",
    })).toBe(false);
    expect(shouldTrustCodexRuntimeStatusForCurrentTurn({
      historyReplay: false,
      synchronized: true,
      resizeReplayActive: false,
      currentPrompt: "continue",
      outputText: currentOutput,
      statusText: "Working",
    })).toBe(true);
  });

  it("错误特征会忽略动态请求信息，但保留可区分的错误详情", () => {
    const sameFirst = classifyCodexCliErrorText("unexpected status 503 Service Unavailable: upstream_status: origin-a, url: https://first.example.test, request id: abcdef123456");
    const sameSecond = classifyCodexCliErrorText("unexpected status 503 Service Unavailable: upstream_status: origin-a, url: https://second.example.test, request id: 987654abcdef");
    const different = classifyCodexCliErrorText("unexpected status 503 Service Unavailable: upstream_status: origin-b, url: https://first.example.test, request id: abcdef123456");

    expect(buildCodexErrorReplayKey(sameFirst!)).toBe(buildCodexErrorReplayKey(sameSecond!));
    expect(buildCodexErrorReplayKey(sameFirst!)).not.toBe(buildCodexErrorReplayKey(different!));
  });

  it("包含清空滚动历史命令的完整同步帧会标记为历史重建", () => {
    let state = createCodexPtyOutputFrameState();
    const chunks = [
      `${SYNC_BEGIN}${CLEAR_HISTORY.slice(0, 17)}`,
      `${CLEAR_HISTORY.slice(17)}■ ${ERROR_TEXT}${SYNC_END}`,
    ];
    const frames = [];

    for (const chunk of chunks) {
      const result = consumeCodexPtyOutputChunk(state, chunk);
      state = result.state;
      frames.push(...result.frames);
    }

    expect(frames).toHaveLength(1);
    expect(frames[0].historyReplay).toBe(true);
    expect(frames[0].synchronized).toBe(true);
  });

  it("连续刷屏和分块重绘中的旧错误会被同一帧末尾的 Working 状态压住", () => {
    const harness = createDetectionHarness();

    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}■ ${ERROR_TEXT.slice(0, 25)}`,
      `${ERROR_TEXT.slice(25)}\nWorking (2m 15s  esc to interrupt)${SYNC_END}`,
      `${SYNC_BEGIN}■ ${ERROR_TEXT}\nWorking (2m 16s  esc to interrupt)${SYNC_END}`,
    ]);

    expect(harness.notifications).toEqual([]);
  });

  it("普通同步刷新会屏蔽同一轮已经处理的错误", () => {
    const harness = createDetectionHarness();
    const snapshot = `${SYNC_BEGIN}■ ${ERROR_TEXT}\n\n› Ask Codex to do anything${SYNC_END}`;

    consumeDetectionSequence(harness, [snapshot, snapshot]);

    expect(harness.notifications).toHaveLength(1);
  });

  it("自动 continue 后从较早位置重放到尾部不会重复上报旧错误", () => {
    const harness = createDetectionHarness();
    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}■ ${ERROR_TEXT}\n\n› Ask Codex to do anything${SYNC_END}`,
    ]);
    expect(harness.notifications).toHaveLength(1);

    harness.turn = 1;
    harness.currentPrompt = "continue";
    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}${CLEAR_HISTORY}■ ${ERROR_TEXT}\n\n› continue\n${SYNC_END}`,
      `${SYNC_BEGIN}■ ${ERROR_TEXT}\nWorking (3m 01s  esc to interrupt)${SYNC_END}`,
    ]);

    expect(harness.notifications).toHaveLength(1);
  });

  it("逐段历史重建时先等待轮次边界，不依赖旧错误是否命中过去的指纹", () => {
    const harness = createDetectionHarness();
    harness.turn = 1;
    harness.currentPrompt = "continue";

    consumeDetectionSequence(harness, [
      `${CLEAR_HISTORY}■ ${ERROR_TEXT}`,
      "\n\n› continue\n\n• Continuing current work\nWorking (3m 01s  esc to interrupt)",
    ]);

    expect(harness.notifications).toHaveLength(0);
    expect(harness.pendingFinal).toBeUndefined();

    const currentError = "unexpected status 503 Service Unavailable: a new current-turn failure";
    consumeDetectionSequence(harness, [
      `\n■ ${currentError}\n\n› Ask Codex to do anything`,
    ]);

    expect(harness.notifications).toEqual([
      buildCodexErrorReplayKey(classifyCodexCliErrorText(currentError)!),
    ]);
  });

  it("自动 continue 后真正再次发生的同类错误仍会上报且后续重放只压住新代次", () => {
    const harness = createDetectionHarness();
    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}■ ${ERROR_TEXT}\n\n› Ask Codex to do anything${SYNC_END}`,
    ]);
    harness.turn = 1;
    harness.currentPrompt = "continue";

    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}${CLEAR_HISTORY}■ ${ERROR_TEXT}\n\n› continue\n\n■ ${ERROR_TEXT}\n\n› Ask Codex to do anything${SYNC_END}`,
    ]);
    expect(harness.notifications).toHaveLength(2);
    expect(harness.handledErrors).toContainEqual(expect.objectContaining({
      key: buildCodexErrorReplayKey(classifyCodexCliErrorText(ERROR_TEXT)! ),
      turn: 1,
    }));

    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}${CLEAR_HISTORY}■ ${ERROR_TEXT}\n\n› continue\n\n■ ${ERROR_TEXT}\n\n› Ask Codex to do anything${SYNC_END}`,
    ]);
    expect(harness.notifications).toHaveLength(2);
  });

  it("同类明确最终错误会按当前屏幕状态作出三态裁决", () => {
    const classification = classifyCodexCliErrorText(`■ ${RATE_LIMIT_TEXT}`)!;
    const handledErrors = rememberCodexErrorReplay([], classification, 0);
    const baseCheck = {
      historyReplay: false,
      synchronized: true,
      resizeReplayActive: false,
      handledErrors,
      classification,
      currentTurn: 1,
      currentPrompt: "continue",
    };

    expect(resolveCodexErrorReplayDecision({
      ...baseCheck,
      outputText: `■ ${RATE_LIMIT_TEXT}\nWorking (3m 01s  esc to interrupt)`,
      currentRuntimePhase: "working",
    })).toBe("suppress");
    expect(resolveCodexErrorReplayDecision({
      ...baseCheck,
      handledErrors: [],
      outputText: `■ ${RATE_LIMIT_TEXT}\nWorking (3m 01s  esc to interrupt)`,
      currentRuntimePhase: "working",
    })).toBe("suppress");
    expect(resolveCodexErrorReplayDecision({
      ...baseCheck,
      outputText: `Working (3m 01s  esc to interrupt)\n■ ${RATE_LIMIT_TEXT}`,
      currentRuntimePhase: "working",
    })).toBe("await-idle");
    expect(resolveCodexErrorReplayDecision({
      ...baseCheck,
      outputText: `■ ${RATE_LIMIT_TEXT}`,
    })).toBe("await-idle");
    expect(resolveCodexErrorReplayDecision({
      ...baseCheck,
      outputText: `› continue\n■ ${RATE_LIMIT_TEXT}\n\n› Ask Codex to do anything`,
      idleScreenConfirmed: true,
    })).toBe("allow");
    expect(resolveCodexErrorReplayDecision({
      ...baseCheck,
      resizeReplayActive: true,
      outputText: `■ ${RATE_LIMIT_TEXT}\n\n› Ask Codex to do anything`,
      idleScreenConfirmed: true,
    })).toBe("await-idle");
    expect(resolveCodexErrorReplayDecision({
      ...baseCheck,
      resizeReplayActive: true,
      outputText: `› continue\n■ ${RATE_LIMIT_TEXT}\n\n› Ask Codex to do anything`,
      idleScreenConfirmed: true,
    })).toBe("allow");
    expect(isCodexRuntimeStatusAfterError(
      `Working (3m 01s  esc to interrupt)\n■ ${RATE_LIMIT_TEXT}`,
      "working",
      classification.matchedText,
    )).toBe(false);
    expect(isCodexRuntimeStatusAfterError(
      `■ ${RATE_LIMIT_TEXT}\nWorking (3m 01s  esc to interrupt)`,
      "working",
      classification.matchedText,
    )).toBe(true);
  });

  it("旧错误后还有本轮输出时不能冒充空闲屏幕上的新失败", () => {
    const classification = classifyCodexCliErrorText(`■ ${RATE_LIMIT_TEXT}`)!;
    const successfulScreen = [
      `■ ${RATE_LIMIT_TEXT}`,
      "",
      "› continue",
      "",
      "• Continuing tool inspection",
      "• 已完成场景检查，没有发现新的异常。",
      "",
      "› Ask Codex to do anything",
    ].join("\n");
    const failedScreen = [
      "› continue",
      "",
      "• Inspecting scene hierarchy",
      `■ ${RATE_LIMIT_TEXT}`,
      "",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(isCodexFinalErrorVisibleOnIdleScreen(
      successfulScreen,
      classification,
      "continue",
    )).toBe(false);
    expect(isCodexFinalErrorVisibleOnIdleScreen(
      failedScreen,
      classification,
      "continue",
    )).toBe(true);
  });

  it("错误后出现运行状态时，输入框不能把它确认成最终错误", () => {
    const finalLine = "■ " + RATE_LIMIT_TEXT;
    const workingScreen = [
      "› continue",
      finalLine,
      "Working (3m 01s  esc to interrupt)",
      "",
      "› Ask Codex to do anything",
    ].join("\n");
    const reconnectingScreen = [
      "› continue",
      finalLine,
      "Reconnecting... 1/5 (3m 01s  esc to interrupt)",
      "",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(hasCodexComposerPrompt(workingScreen)).toBe(true);
    expect(hasCodexComposerPrompt(reconnectingScreen)).toBe(true);
    expect(classifyCodexFinalErrorOnIdleScreen(workingScreen, "continue")).toBeNull();
    expect(classifyCodexFinalErrorOnIdleScreen(reconnectingScreen, "continue")).toBeNull();
  });

  it("额度重置提示与 MCP 启动状态同屏时不能冒充最终错误", () => {
    const screen = [
      "• You have 1 usage limit reset available. Run /usage to use one.",
      "• Starting MCP servers (3/4): codebase-memory-mcp (7s • esc to interrupt)",
      "",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(classifyCodexCliErrorText(screen)).toBeNull();
    expect(classifyCodexFinalErrorOnIdleScreen(screen)).toBeNull();
  });

  it("容量错误使用警告标记时仍能确认最终失败", () => {
    const screen = [
      "› continue",
      "",
      "⚠ Selected model is at capacity. Please try a different model.",
      "",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(classifyCodexFinalErrorOnIdleScreen(screen, "continue")).toEqual(expect.objectContaining({
      kind: "modelCapacity",
      phase: "final",
      explicitFinal: true,
    }));
  });

  it.each(["› Run /review on my current changes", "› Ask Codex to do anything"])(
    "压缩成功后的 Heads up 提醒不是错误，也不是中断信号：%s",
    (composer) => {
      const warning = "⚠Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";
      const screen = [
        "› 继续核对",
        "• 检查已完成。",
        "─ Worked for 2m 16s ─",
        "• Context compacted",
        warning,
        "",
        composer,
      ].join("\n");
      expect(classifyCodexCliErrorText(warning)).toBeNull();
      expect(classifyCodexCliErrorText(screen)).toBeNull();
      expect(classifyCodexFinalErrorOnIdleScreen(screen, "继续核对")).toBeNull();
      expect(detectCodexCliRuntimeStatusText(screen)).toBeNull();

      const workingScreen = `Working (2m 15s  esc to interrupt)\n${warning}\n${composer}`;
      expect(detectCodexCliRuntimeStatusText(workingScreen)?.phase).toBe("working");
      expect(classifyCodexFinalErrorOnIdleScreen(workingScreen)).toBeNull();
      const harness = createDetectionHarness();
      harness.turn = 1;
      harness.currentPrompt = "继续核对";
      consumeDetectionSequence(harness, [`${SYNC_BEGIN}${screen}${SYNC_END}`]);
      expect(harness.notifications).toEqual([]);
      expect(harness.pendingFinal).toBeUndefined();
    },
  );

  it.each(["⚠", "⚠\ufe0f", "⚠\ufe0e ", "⚠ ", "■", "▪ "])(
    "容量错误紧贴标记或含变体选择符时仍能确认：%s",
    (marker) => {
      const screen = [
        "⚠Selected model is at capacity. Please try a different model.",
        "› 继续",
        `${marker}Selected model is at capacity. Please try a different model.`,
        "",
        "› Ask Codex to do anything",
      ].join("\n");
      expect(classifyCodexFinalErrorOnIdleScreen(screen, "继续")).toMatchObject({
        kind: "modelCapacity",
        phase: "final",
        explicitFinal: true,
      });
    },
  );

  it.each([
    "⚠Error running remote compact task: Selected model is at capacity. Please try a different model.",
    "⚠ Selected model is at capacity. Please try a different model.",
    "■ Error running remote compact task: unexpected status 503 Service Unavailable",
  ])("错误与输入框之间的后台终端栏不阻止失败确认：%s", (errorLine) => {
    for (const footer of [
      "  1 background terminal running · /ps to view · /stop to close",
      "  2 background terminals running · /ps to view · /stop to close",
    ]) {
      const screen = [
        "• You have 2 usage limit resets available. Run /usage to use one.",
        "⚠MCP startup incomplete (failed: example_tool)",
        "⚠Selected model is at capacity. Please try a different model.",
        "› 继续",
        "• 已完成检查。",
        errorLine,
        footer,
        "",
        "› Ask Codex to do anything",
        "Context 15% left · Goal stalled (/goal resume)",
      ].join("\n");
      expect(classifyCodexFinalErrorOnIdleScreen(screen, "继续")).toMatchObject({
        kind: errorLine.includes("503") ? "serviceUnavailable" : "modelCapacity",
        phase: "final",
        explicitFinal: true,
      });
    }
  });

  it.each([
    "› 继续",
    "• 已处理之前的错误。",
    "Working (1m 03s  esc to interrupt)",
    "Reconnecting... 1/5 (1m 03s  esc to interrupt)",
    "■ 普通说明：Selected model is at capacity 已恢复。",
    "⚠MCP startup incomplete: Selected model is at capacity",
  ])("后台终端栏不能掩盖错误后的新输入、输出或运行状态：%s", (laterLine) => {
    const screen = [
      "› 继续",
      "⚠Selected model is at capacity. Please try a different model.",
      laterLine,
      "  1 background terminal running · /ps to view · /stop to close",
      "",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(classifyCodexFinalErrorOnIdleScreen(screen, "继续")).toBeNull();
  });

  it("紧贴标记的压缩容量错误每轮只处理一次，下一轮同类新错误仍能上报", () => {
    const harness = createDetectionHarness();
    const error = "⚠Error running remote compact task: Selected model is at capacity. Please try a different model.";
    const screen = `› 继续\n${error}\n  1 background terminal running · /ps to view · /stop to close\n\n› Ask Codex to do anything`;
    harness.currentPrompt = "继续";
    harness.turn = 1;
    consumeDetectionSequence(harness, [`${SYNC_BEGIN}${screen}${SYNC_END}`]);
    expect(harness.notifications).toHaveLength(1);
    consumeDetectionSequence(harness, [`${SYNC_BEGIN}${CLEAR_HISTORY}${screen}${SYNC_END}`], true);
    expect(harness.notifications).toHaveLength(1);
    harness.turn = 2;
    consumeDetectionSequence(harness, [`${SYNC_BEGIN}${error}\n› 继续\nWorking (1s  esc to interrupt)${SYNC_END}`]);
    expect(harness.notifications).toHaveLength(1);
    consumeDetectionSequence(harness, [`${SYNC_BEGIN}${screen}${SYNC_END}`]);
    expect(harness.notifications).toHaveLength(2);
  });

  it("服务过载的高负载兜底警告也能确认最终失败", () => {
    const screen = [
      "› continue",
      "",
      "⚠ Codex is currently experiencing high load.",
      "",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(classifyCodexFinalErrorOnIdleScreen(screen, "continue")).toEqual(expect.objectContaining({
      kind: "highDemand",
      phase: "final",
      explicitFinal: true,
    }));
  });

  it("带外层网络错误包装的红色终态行仍能确认最终失败", () => {
    const cases = [
      ["■ Error while reading the server response: HTTP status server error (503 Service Unavailable)", "serviceUnavailable"],
      ["■ rate limit exceeded: retry later", "rateLimited"],
      ["■ Connection failed: error sending request", "networkStream"],
      ["■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.", "usageLimit"],
    ] as const;

    for (const [errorLine, kind] of cases) {
      const screen = [
        "› continue",
        "",
        errorLine,
        "",
        "› Ask Codex to do anything",
      ].join("\n");
      expect(classifyCodexFinalErrorOnIdleScreen(screen, "continue")).toEqual(expect.objectContaining({
        kind,
        phase: "final",
        explicitFinal: true,
      }));
    }
  });

  it("屏幕确认允许动态错误详情变化，但普通输出不能冒充最终错误", () => {
    const candidate = classifyCodexCliErrorText(
      "■ unexpected status 503 Service Unavailable: request id: first-request",
    )!;
    const currentErrorScreen = [
      "› continue",
      "",
      "■ unexpected status 503 Service Unavailable: request id: second-request",
      "",
      "› Ask Codex to do anything",
    ].join("\n");
    const ordinaryOutputScreen = [
      "› continue",
      "",
      "• The previous 503 Service Unavailable issue has been handled.",
      "",
      "› Ask Codex to do anything",
    ].join("\n");
    const quotedExplicitErrorScreen = [
      "› continue",
      "",
      "• Selected model is at capacity was the previous failure and has been handled.",
      "",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(isCodexFinalErrorVisibleOnIdleScreen(
      currentErrorScreen,
      candidate,
      "continue",
    )).toBe(true);
    expect(isCodexFinalErrorVisibleOnIdleScreen(
      ordinaryOutputScreen,
      candidate,
      "continue",
    )).toBe(false);
    expect(classifyCodexFinalErrorOnIdleScreen(
      quotedExplicitErrorScreen,
      "continue",
    )).toBeNull();
  });

  it("稳定屏幕会返回当前真实错误，不沿用历史候选的错误类别", () => {
    const historicalCandidate = classifyCodexCliErrorText(`■ ${RATE_LIMIT_TEXT}`)!;
    const currentErrorScreen = [
      "› continue",
      "",
      `■ ${ERROR_TEXT}`,
      "",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(isCodexFinalErrorVisibleOnIdleScreen(
      currentErrorScreen,
      historicalCandidate,
      "continue",
    )).toBe(false);
    expect(classifyCodexFinalErrorOnIdleScreen(
      currentErrorScreen,
      "continue",
    )).toEqual(expect.objectContaining({
      kind: "serviceUnavailable",
      phase: "final",
      explicitFinal: true,
    }));
  });

  it("所有已支持错误类型都按当前输入边界区分历史错误与本轮真实错误", () => {
    const detectedKinds = new Set<string>();

    for (const errorText of GENERIC_FINAL_ERROR_TEXTS) {
      const initialClassification = classifyCodexCliErrorText(`■ ${errorText}`);
      const finalMarker = initialClassification?.kind === "highDemand"
        || initialClassification?.kind === "modelCapacity"
        ? "⚠"
        : "■";
      const classification = classifyCodexCliErrorText(`${finalMarker} ${errorText}`);
      expect(classification).not.toBeNull();
      expect(classification?.phase).toBe("final");
      expect(classification?.explicitFinal).toBe(true);
      detectedKinds.add(classification!.kind);

      const partialClassification = classifyCodexCliErrorText(errorText)!;
      expect(resolveCodexErrorReplayDecision({
        historyReplay: false,
        synchronized: true,
        resizeReplayActive: false,
        handledErrors: [],
        classification: partialClassification,
        currentTurn: 1,
        currentPrompt: "continue",
        outputText: errorText,
      })).toBe("await-idle");
      expect(resolveCodexErrorReplayDecision({
        historyReplay: false,
        resizeReplayActive: false,
        handledErrors: [],
        classification: partialClassification,
        currentTurn: 1,
        currentPrompt: "continue",
        outputText: `${errorText}\nWorking (1s • esc to interrupt)`,
        currentRuntimePhase: "working",
      })).toBe("suppress");

      const historicalScreen = [
        `${finalMarker} ${errorText}`,
        "",
        "› continue",
        "",
        "• Continuing current work",
        "",
        "› Ask Codex to do anything",
      ].join("\n");
      expect(resolveCodexErrorReplayDecision({
        historyReplay: false,
        synchronized: true,
        resizeReplayActive: false,
        handledErrors: [],
        classification: classification!,
        currentTurn: 1,
        currentPrompt: "continue",
        outputText: historicalScreen,
        idleScreenConfirmed: true,
      })).toBe("suppress");

      const handledErrors = rememberCodexErrorReplay([], classification!, 0);
      const failedScreen = [
        "› continue",
        "",
        `${finalMarker} ${errorText}`,
        "",
        "› Ask Codex to do anything",
      ].join("\n");
      const currentTurnCheck = {
        historyReplay: false,
        synchronized: true,
        resizeReplayActive: false,
        handledErrors,
        classification: classification!,
        currentTurn: 1,
        currentPrompt: "continue",
        outputText: failedScreen,
      };
      expect(resolveCodexErrorReplayDecision(currentTurnCheck)).toBe("await-idle");
      expect(isCodexFinalErrorVisibleOnIdleScreen(
        failedScreen,
        classification!,
        "continue",
      )).toBe(true);
      expect(resolveCodexErrorReplayDecision({
        ...currentTurnCheck,
        idleScreenConfirmed: true,
      })).toBe("allow");
    }

    expect(detectedKinds.size).toBe(12);
  });

  it("自动 continue 后先压住旧 429，随后真实 429 仍必须上报", () => {
    const harness = createDetectionHarness();
    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}■ ${RATE_LIMIT_TEXT}\n\n› Ask Codex to do anything${SYNC_END}`,
    ]);
    expect(harness.notifications).toHaveLength(1);

    harness.turn = 1;
    harness.currentPrompt = "continue";
    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}■ ${RATE_LIMIT_TEXT}${SYNC_END}`,
    ]);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.pendingFinal?.classification.kind).toBe("rateLimited");

    consumeDetectionSequence(harness, [
      `${SYNC_BEGIN}■ ${RATE_LIMIT_TEXT}\n\n› continue\n\n• Inspecting tools\nWorking (3m 01s  esc to interrupt)${SYNC_END}`,
      `${SYNC_BEGIN}■ ${RATE_LIMIT_TEXT}\n\n› continue\n\n• Inspecting tools\n• Reading current scene\n■ ${RATE_LIMIT_TEXT}\n\n› Ask Codex to do anything${SYNC_END}`,
    ]);

    expect(harness.notifications).toHaveLength(2);
    expect(harness.handledErrors).toContainEqual(expect.objectContaining({
      key: buildCodexErrorReplayKey(classifyCodexCliErrorText(RATE_LIMIT_TEXT)!),
      turn: 1,
      phases: ["final"],
    }));
  });

  it("非历史重放期间同类错误经屏幕确认后可在新的 continue 代次再次上报", () => {
    const handledErrors = rememberCodexErrorReplay([], FINAL_ERROR, 0);

    expect(shouldSuppressCodexErrorReplay({
      historyReplay: false,
      resizeReplayActive: false,
      handledErrors,
      classification: FINAL_ERROR,
      currentTurn: 1,
      currentPrompt: "continue",
      outputText: `■ ${ERROR_TEXT}`,
      idleScreenConfirmed: true,
    })).toBe(false);
  });

  it("阶段只在同一轮次累计，新轮次重连后的最终失败仍会处理", () => {
    const reconnectingError: CodexCliErrorClassification = {
      ...FINAL_ERROR,
      phase: "reconnecting",
    };
    let handledErrors = rememberCodexErrorReplay([], reconnectingError, 0);
    handledErrors = rememberCodexErrorReplay(handledErrors, FINAL_ERROR, 0);

    const currentTurnOutput = ["› continue", "Reconnecting... 1/5", ERROR_TEXT].join("\n");
    expect(shouldSuppressCodexErrorReplay({
      historyReplay: false,
      synchronized: true,
      resizeReplayActive: false,
      handledErrors,
      classification: reconnectingError,
      currentTurn: 1,
      currentPrompt: "continue",
      outputText: currentTurnOutput,
    })).toBe(false);

    handledErrors = rememberCodexErrorReplay(handledErrors, reconnectingError, 1);
    expect(handledErrors).toContainEqual(expect.objectContaining({
      key: buildCodexErrorReplayKey(FINAL_ERROR),
      turn: 1,
      phases: ["reconnecting"],
    }));
    expect(shouldSuppressCodexErrorReplay({
      historyReplay: false,
      synchronized: true,
      resizeReplayActive: false,
      handledErrors,
      classification: FINAL_ERROR,
      currentTurn: 1,
      currentPrompt: "continue",
      outputText: ["› continue", "■ " + ERROR_TEXT].join("\n"),
      idleScreenConfirmed: true,
    })).toBe(false);
  });

  it("当前输入之前的旧轮次不同阶段错误仍会被历史重绘压制", () => {
    const reconnectingError: CodexCliErrorClassification = {
      ...FINAL_ERROR,
      phase: "reconnecting",
    };
    const handledErrors = rememberCodexErrorReplay([], reconnectingError, 0);

    expect(shouldSuppressCodexErrorReplay({
      historyReplay: true,
      synchronized: true,
      resizeReplayActive: false,
      handledErrors,
      classification: FINAL_ERROR,
      currentTurn: 1,
      currentPrompt: "continue",
      outputText: ["■ " + ERROR_TEXT, "› continue"].join("\n"),
    })).toBe(true);
  });

  it("未完整回显当前输入的历史重绘也会压制旧轮次不同阶段错误", () => {
    const reconnectingError: CodexCliErrorClassification = {
      ...FINAL_ERROR,
      phase: "reconnecting",
    };
    const handledErrors = rememberCodexErrorReplay([], reconnectingError, 0);

    expect(shouldSuppressCodexErrorReplay({
      historyReplay: true,
      synchronized: true,
      resizeReplayActive: false,
      handledErrors,
      classification: FINAL_ERROR,
      currentTurn: 1,
      currentPrompt: "continue",
      outputText: "■ " + ERROR_TEXT,
    })).toBe(true);
  });

  it("延迟到达的旧轮次输出不会覆盖已经确认的新轮次记录", () => {
    const reconnectingError: CodexCliErrorClassification = {
      ...FINAL_ERROR,
      phase: "reconnecting",
    };
    let handledErrors = rememberCodexErrorReplay([], FINAL_ERROR, 2);
    handledErrors = rememberCodexErrorReplay(handledErrors, reconnectingError, 1);

    expect(handledErrors).toContainEqual(expect.objectContaining({
      key: buildCodexErrorReplayKey(FINAL_ERROR),
      turn: 2,
      phases: ["final"],
    }));
  });

  it("缩放回放仍会屏蔽当前代次已处理的同一错误，但不会屏蔽内容不同的新错误", () => {
    const handledErrors = rememberCodexErrorReplay([], FINAL_ERROR, 0);
    const differentError = {
      ...FINAL_ERROR,
      matchedText: "unexpected status 503 Service Unavailable: another request",
    };

    expect(shouldSuppressCodexErrorReplay({
      historyReplay: false,
      resizeReplayActive: true,
      handledErrors,
      classification: FINAL_ERROR,
      currentTurn: 0,
      currentPrompt: "",
      outputText: `■ ${ERROR_TEXT}`,
    })).toBe(true);
    expect(resolveCodexErrorReplayDecision({
      historyReplay: false,
      resizeReplayActive: true,
      handledErrors,
      classification: differentError,
      currentTurn: 0,
      currentPrompt: "",
      outputText: `■ ${differentError.matchedText}`,
    })).toBe("await-idle");
    expect(resolveCodexErrorReplayDecision({
      historyReplay: false,
      resizeReplayActive: true,
      handledErrors,
      classification: differentError,
      currentTurn: 0,
      currentPrompt: "continue",
      outputText: `› continue\n■ ${differentError.matchedText}\n› Ask Codex to do anything`,
      idleScreenConfirmed: true,
    })).toBe("allow");
  });

  it("错误历史达到上限后只保留最近记录和最新代次", () => {
    let handledErrors: CodexErrorReplayRecord[] = [];
    for (let index = 0; index <= CODEX_ERROR_REPLAY_HISTORY_LIMIT; index += 1) {
      handledErrors = rememberCodexErrorReplay(handledErrors, {
        ...FINAL_ERROR,
        matchedText: `error-${index}`,
      }, index);
    }
    handledErrors = rememberCodexErrorReplay(handledErrors, FINAL_ERROR, 1);
    handledErrors = rememberCodexErrorReplay(handledErrors, FINAL_ERROR, 3);

    expect(handledErrors).toHaveLength(CODEX_ERROR_REPLAY_HISTORY_LIMIT);
    expect(handledErrors).not.toContainEqual(expect.objectContaining({
      key: buildCodexErrorReplayKey({ ...FINAL_ERROR, matchedText: "error-0" }),
    }));
    expect(handledErrors).toContainEqual(expect.objectContaining({
      key: buildCodexErrorReplayKey(FINAL_ERROR),
      turn: 3,
    }));
  });
});
