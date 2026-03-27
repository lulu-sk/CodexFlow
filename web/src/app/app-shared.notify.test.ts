import { describe, it, expect } from "vitest";
import {
  CODEX_NOTIFY_ENV_KEYS,
  CLAUDE_NOTIFY_ENV_KEYS,
  GEMINI_NOTIFY_ENV_KEYS,
  buildProviderNotifyEnv,
  hasMeaningfulCompletionPreview,
  isAgentCompletionMessage,
  normalizeCompletionPreview,
  normalizeDisplayedCompletionPreviewForDedupe,
  normalizeCompletionPreviewForDedupe,
  shouldDedupeCrossSourceCompletion,
  shouldDelayOscCompletionForExternalFallback,
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

  it("normalizeCompletionPreviewForDedupe：统一空白并清理前缀", () => {
    expect(normalizeCompletionPreviewForDedupe(" agent-turn-complete:\n已完成\t任务   输出 ")).toBe("已完成 任务 输出");
  });

  it("normalizeCompletionPreview：将字面量换行恢复为展示态换行", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: 已处理。\\n\\n我把测试里的真实本机路径替换掉了。")).toBe("已处理。\n\n我把测试里的真实本机路径替换掉了。");
  });

  it("normalizeCompletionPreview：兼容新版 Codex 的 title case 通用完成文案", () => {
    expect(normalizeCompletionPreview("Agent turn complete")).toBe("");
    expect(normalizeCompletionPreview("Agent turn complete: 已处理 README")).toBe("已处理 README");
  });

  it("normalizeCompletionPreview：协议显式声明不解码时保留字面量换行", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: 使用 \\n 分隔段落", { previewEscapedWhitespace: false })).toBe("使用 \\n 分隔段落");
  });

  it("normalizeCompletionPreview：协议显式声明可解码时恢复字面量换行", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: 使用 \\n 分隔段落", { previewEscapedWhitespace: true })).toBe("使用 \n 分隔段落");
  });

  it("normalizeCompletionPreview：协议显式声明可解码时同步恢复 JSON 常见转义", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: \\\"引用\\\" \\u4F60\\u597D\\n第二行", { previewEscapedWhitespace: true })).toBe("\"引用\" 你好\n第二行");
  });

  it("normalizeCompletionPreview：协议显式声明可解码时保留双反斜杠字面量", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: 请原样输出：\\\\n", { previewEscapedWhitespace: true })).toBe("请原样输出：\\n");
  });

  it("normalizeCompletionPreviewForDedupe：兼容字面量转义空白", () => {
    expect(normalizeCompletionPreviewForDedupe("agent-turn-complete: 已完成\\n- 位置： [accountStore.ts]")).toBe("已完成 - 位置： [accountStore.ts]");
  });

  it("normalizeCompletionPreviewForDedupe：协议显式声明保留字面量换行时不误解码", () => {
    expect(normalizeCompletionPreviewForDedupe("agent-turn-complete: 使用 \\n 分隔段落", { previewEscapedWhitespace: false })).toBe("使用 \\n 分隔段落");
  });

  it("normalizeCompletionPreview：不误伤 Windows 路径中的反斜杠片段", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: 已完成 C:\\new\\temp\\task.md")).toBe("已完成 C:\\new\\temp\\task.md");
  });

  it("normalizeCompletionPreview：兼容旧协议时仍可解码普通冒号后的字面量换行", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: 摘要:\\n- 第一项")).toBe("摘要:\n- 第一项");
  });

  it("normalizeCompletionPreview：兼容旧协议时可解码英文单词后的字面量换行", () => {
    expect(normalizeCompletionPreview("agent-turn-complete: Summary\\n- First item")).toBe("Summary\n- First item");
  });

  it("normalizeCompletionPreviewForDedupe：不误伤 Windows 路径中的反斜杠片段", () => {
    expect(normalizeCompletionPreviewForDedupe("agent-turn-complete: 已完成 C:\\new\\temp\\task.md")).toBe("已完成 C:\\new\\temp\\task.md");
  });

  it("normalizeDisplayedCompletionPreviewForDedupe：仅折叠真实空白并保留字面量换行", () => {
    expect(normalizeDisplayedCompletionPreviewForDedupe("第一行\n  第二行  \\n 第三段")).toBe("第一行 第二行 \\n 第三段");
  });

  it("hasMeaningfulCompletionPreview：区分通用完成信号与真实摘要", () => {
    expect(hasMeaningfulCompletionPreview("")).toBe(false);
    expect(hasMeaningfulCompletionPreview("   ")).toBe(false);
    expect(hasMeaningfulCompletionPreview("已处理 README")).toBe(true);
  });

  it("shouldDedupeCrossSourceCompletion：先收到通用 OSC、后收到 external 详情时放行详情", () => {
    expect(shouldDedupeCrossSourceCompletion("", "已处理 README", 1200, 5000, false)).toBe(false);
  });

  it("shouldDedupeCrossSourceCompletion：先收到详情、后收到通用完成信号时继续去重", () => {
    expect(shouldDedupeCrossSourceCompletion("已处理 README", "", 1200, 5000, false)).toBe(true);
  });

  it("shouldDedupeCrossSourceCompletion：重新进入 working 后不吞掉新一轮完成事件", () => {
    expect(shouldDedupeCrossSourceCompletion("", "已处理 README", 1200, 5000, true)).toBe(false);
  });

  it("shouldDelayOscCompletionForExternalFallback：仅 Codex 需要优先等待 external 预览", () => {
    expect(shouldDelayOscCompletionForExternalFallback("codex")).toBe(true);
    expect(shouldDelayOscCompletionForExternalFallback("Codex")).toBe(true);
    expect(shouldDelayOscCompletionForExternalFallback("claude")).toBe(false);
    expect(shouldDelayOscCompletionForExternalFallback("gemini")).toBe(false);
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

  it("buildProviderNotifyEnv：Codex 注入 CODEXFLOW_NOTIFY_*", () => {
    const env = buildProviderNotifyEnv("tab-3", "codex", "Ubuntu-24.04");
    expect(env).toEqual({
      [CODEX_NOTIFY_ENV_KEYS.tabId]: "tab-3",
      [CODEX_NOTIFY_ENV_KEYS.envLabel]: "Ubuntu-24.04",
      [CODEX_NOTIFY_ENV_KEYS.providerId]: "codex",
    });
  });

  it("buildProviderNotifyEnv：其它 provider 不注入", () => {
    expect(buildProviderNotifyEnv("tab-3", "terminal", "Ubuntu-24.04")).toEqual({});
  });
});
