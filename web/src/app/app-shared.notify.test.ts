import { describe, it, expect } from "vitest";
import {
  CLAUDE_NOTIFY_ENV_KEYS,
  GEMINI_NOTIFY_ENV_KEYS,
  buildProviderNotifyEnv,
  isAgentCompletionMessage,
} from "./app-shared";

describe("app-shared（完成通知：识别与环境变量注入）", () => {
  it("isAgentCompletionMessage：空 payload 也视为完成事件", () => {
    expect(isAgentCompletionMessage("")).toBe(true);
    expect(isAgentCompletionMessage("   ")).toBe(true);
  });

  it("isAgentCompletionMessage：过滤非完成类通知（approval requested / codex wants to edit）", () => {
    expect(isAgentCompletionMessage("Approval requested: run rm -rf")).toBe(false);
    expect(isAgentCompletionMessage("codex wants to edit foo.ts")).toBe(false);
  });

  it("buildProviderNotifyEnv：Gemini 注入 GEMINI_CLI_CODEXFLOW_*", () => {
    const env = buildProviderNotifyEnv("tab-1", "gemini", "Ubuntu-24.04");
    expect(env).toEqual({
      [GEMINI_NOTIFY_ENV_KEYS.tabId]: "tab-1",
      [GEMINI_NOTIFY_ENV_KEYS.envLabel]: "Ubuntu-24.04",
      [GEMINI_NOTIFY_ENV_KEYS.providerId]: "gemini",
    });
  });

  it("buildProviderNotifyEnv：Claude 注入 CLAUDE_CODEXFLOW_*", () => {
    const env = buildProviderNotifyEnv("tab-2", "claude", "Ubuntu-24.04");
    expect(env).toEqual({
      [CLAUDE_NOTIFY_ENV_KEYS.tabId]: "tab-2",
      [CLAUDE_NOTIFY_ENV_KEYS.envLabel]: "Ubuntu-24.04",
      [CLAUDE_NOTIFY_ENV_KEYS.providerId]: "claude",
    });
  });

  it("buildProviderNotifyEnv：其它 provider 不注入", () => {
    expect(buildProviderNotifyEnv("tab-3", "codex", "Ubuntu-24.04")).toEqual({});
    expect(buildProviderNotifyEnv("tab-3", "terminal", "Ubuntu-24.04")).toEqual({});
  });
});

