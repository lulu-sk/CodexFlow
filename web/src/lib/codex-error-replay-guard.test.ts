import { describe, expect, it } from "vitest";
import {
  classifyCodexCliErrorText,
  type CodexCliErrorClassification,
} from "./codex-cli-error-classifier";
import {
  CODEX_ERROR_REPLAY_HISTORY_LIMIT,
  buildCodexErrorReplayKey,
  rememberCodexErrorReplayKey,
  shouldSuppressCodexErrorResizeReplay,
} from "./codex-error-replay-guard";

const FINAL_ERROR: CodexCliErrorClassification = {
  kind: "networkStream",
  severity: "temporary",
  retryable: true,
  matchedText: "Stream disconnected before completion: Upstream request failed",
  phase: "final",
};

describe("codex-error-replay-guard（Codex 缩放错误回放防护）", () => {
  it("真实分类结果会把同一错误的重连态与最终态归为同一特征", () => {
    const reconnectingError = classifyCodexCliErrorText(`
      Reconnecting... 4/5 (2m 10s  esc to interrupt)
        Stream disconnected before completion: Upstream request failed
    `);
    const finalError = classifyCodexCliErrorText(`
      ■ stream disconnected before completion: Upstream request failed
      › Continue
    `);

    expect(reconnectingError?.phase).toBe("reconnecting");
    expect(finalError?.phase).toBe("final");
    expect(reconnectingError).not.toBeNull();
    expect(finalError).not.toBeNull();
    expect(buildCodexErrorReplayKey(reconnectingError!)).toBe(buildCodexErrorReplayKey(finalError!));
  });

  it("错误特征会忽略阶段、大小写、空白和重连次数", () => {
    const reconnectingError: CodexCliErrorClassification = {
      ...FINAL_ERROR,
      matchedText: "  stream disconnected before completion:   upstream request failed  ",
      phase: "reconnecting",
      reconnectAttempt: 4,
      reconnectMaxAttempts: 5,
    };

    expect(buildCodexErrorReplayKey(reconnectingError)).toBe(buildCodexErrorReplayKey(FINAL_ERROR));
  });

  it("缩放时会屏蔽已经处理过的同一条错误", () => {
    const handledErrorKeys = rememberCodexErrorReplayKey([], FINAL_ERROR);

    expect(shouldSuppressCodexErrorResizeReplay({
      resizeReplayActive: true,
      handledErrorKeys,
      classification: FINAL_ERROR,
    })).toBe(true);
  });

  it("缩放时不会屏蔽内容不同的新错误", () => {
    const handledErrorKeys = rememberCodexErrorReplayKey([], FINAL_ERROR);
    const newError: CodexCliErrorClassification = {
      ...FINAL_ERROR,
      matchedText: "Stream disconnected before completion: Incomplete response returned",
    };

    expect(shouldSuppressCodexErrorResizeReplay({
      resizeReplayActive: true,
      handledErrorKeys,
      classification: newError,
    })).toBe(false);
  });

  it("非缩放期间不会屏蔽再次真实出现的同一条错误", () => {
    const handledErrorKeys = rememberCodexErrorReplayKey([], FINAL_ERROR);

    expect(shouldSuppressCodexErrorResizeReplay({
      resizeReplayActive: false,
      handledErrorKeys,
      classification: FINAL_ERROR,
    })).toBe(false);
  });

  it("错误历史达到上限后只保留最近记录", () => {
    let handledErrorKeys: string[] = [];
    for (let index = 0; index <= CODEX_ERROR_REPLAY_HISTORY_LIMIT; index++) {
      handledErrorKeys = rememberCodexErrorReplayKey(handledErrorKeys, {
        ...FINAL_ERROR,
        matchedText: `error-${index}`,
      });
    }

    expect(handledErrorKeys).toHaveLength(CODEX_ERROR_REPLAY_HISTORY_LIMIT);
    expect(handledErrorKeys).not.toContain(buildCodexErrorReplayKey({ ...FINAL_ERROR, matchedText: "error-0" }));
    expect(handledErrorKeys).toContain(buildCodexErrorReplayKey({
      ...FINAL_ERROR,
      matchedText: `error-${CODEX_ERROR_REPLAY_HISTORY_LIMIT}`,
    }));
  });
});
