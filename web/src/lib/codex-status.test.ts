import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { formatResetTime, formatWindowLabel, isCodexAccountSignedIn } from "./codex-status";

afterEach(() => { vi.useRealTimers(); });
const translate = ((key: string, fallback?: string) => fallback || key) as TFunction;

describe("Codex 账号与重置时间展示", () => {
  it("官方接口明确已登录但没有邮箱或 ID 时仍显示已登录", () => {
    expect(isCodexAccountSignedIn({ authMode: "chatgpt", accountId: null, userId: null, email: null, plan: "business" })).toBe(true);
    expect(isCodexAccountSignedIn({ authMode: null, accountId: null, userId: null, email: null, plan: null })).toBe(false);
  });

  it("缓存中的绝对重置时间不会随着渲染推迟", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T08:00:00Z"));
    const resetsAt = Date.parse("2026-02-01T09:00:00Z") / 1000;
    const first = formatResetTime(3600, translate, "en", resetsAt);
    vi.setSystemTime(new Date("2026-02-01T08:30:00Z"));
    expect(formatResetTime(3600, translate, "en", resetsAt)).toBe(first);
    vi.setSystemTime(new Date("2026-02-01T09:00:00Z"));
    expect(formatResetTime(3600, translate, "en", resetsAt)).toBe("已重置");
  });

  it("缺失窗口信息不能显示不限额度", () => {
    expect(formatWindowLabel(null, translate)).toBe("未知窗口");
  });
});
