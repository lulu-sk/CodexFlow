import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { formatGrokUsageErrorText } from "./grok-status";

/**
 * 构造直接返回默认文案的最小翻译函数桩。
 */
function createTranslator(): TFunction {
  return ((key: string, fallback?: string | { defaultValue?: string }) => {
    if (typeof fallback === "string") return fallback;
    return fallback?.defaultValue || key;
  }) as unknown as TFunction;
}

describe("formatGrokUsageErrorText", () => {
  it("API Key 登录说明官方限制和查询入口", () => {
    const text = formatGrokUsageErrorText(new Error("GROK_USAGE_API_KEY_UNSUPPORTED"), createTranslator());

    expect(text).toContain("API Key 不提供账号额度");
    expect(text).toContain("console.x.ai");
  });

  it("未登录时提示使用 Grok 官方网页登录", () => {
    const text = formatGrokUsageErrorText("Error: GROK_USAGE_AUTH_REQUIRED", createTranslator());

    expect(text).toContain("未使用网页登录");
    expect(text).toContain("grok login");
  });

  it("未知错误不暴露底层错误正文", () => {
    const text = formatGrokUsageErrorText("request failed with secret detail", createTranslator());

    expect(text).toBe("无法获取 Grok 账号额度\n请检查网络和 Grok Build 登录状态后重试");
    expect(text).not.toContain("secret detail");
  });
});
