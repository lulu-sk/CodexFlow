import { describe, expect, it } from "vitest";
import {
  CODEX_AUTO_CONTINUE_ERROR_KINDS,
  CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION,
  CODEX_DEFAULT_AUTO_CONTINUE_ERROR_KINDS,
  normalizeCodexErrorHandlingPrefs,
} from "./codex-error-handling-settings";

describe("codex-error-handling-settings（Codex 错误处理设置）", () => {
  it("自动 continue 最大尝试次数默认 5 次且不设置上限", () => {
    expect(normalizeCodexErrorHandlingPrefs({}).autoContinueMaxAttempts).toBe(5);
    expect(normalizeCodexErrorHandlingPrefs({ autoContinueMaxAttempts: 30 }).autoContinueMaxAttempts).toBe(30);
  });

  it("自动 continue 最大尝试次数只保留非负整数下限", () => {
    expect(normalizeCodexErrorHandlingPrefs({ autoContinueMaxAttempts: -1 }).autoContinueMaxAttempts).toBe(0);
    expect(normalizeCodexErrorHandlingPrefs({ autoContinueMaxAttempts: 3.6 }).autoContinueMaxAttempts).toBe(4);
  });

  it("重连中错误通知默认关闭且可显式开启", () => {
    expect(normalizeCodexErrorHandlingPrefs({}).notifyReconnectErrors).toBe(false);
    expect(normalizeCodexErrorHandlingPrefs({ notifyReconnectErrors: true }).notifyReconnectErrors).toBe(true);
  });

  it("旧配置缺少错误类型列表时默认覆盖默认可自动 continue 错误", () => {
    expect(normalizeCodexErrorHandlingPrefs({ autoContinueEnabled: true }).autoContinueErrorKinds)
      .toEqual(CODEX_DEFAULT_AUTO_CONTINUE_ERROR_KINDS);
  });

  it("413 错误可手动配置自动 continue 但默认不勾选", () => {
    expect(CODEX_AUTO_CONTINUE_ERROR_KINDS).toContain("payloadTooLarge");
    expect(CODEX_DEFAULT_AUTO_CONTINUE_ERROR_KINDS).not.toContain("payloadTooLarge");
    expect(normalizeCodexErrorHandlingPrefs({}).autoContinueErrorKinds).not.toContain("payloadTooLarge");
    expect(normalizeCodexErrorHandlingPrefs({
      autoContinueErrorKinds: ["payloadTooLarge"],
      autoContinueErrorKindsVersion: CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION,
    }).autoContinueErrorKinds).toEqual(["payloadTooLarge"]);
  });

  it("用户显式清空错误类型列表时应保留空选择", () => {
    expect(normalizeCodexErrorHandlingPrefs({ autoContinueErrorKinds: [] }).autoContinueErrorKinds).toEqual([]);
  });

  it("过滤非法错误类型并保持稳定顺序", () => {
    expect(normalizeCodexErrorHandlingPrefs({
      autoContinueErrorKinds: ["badGateway", "badGateway", "usageLimit", "networkStream"],
    }).autoContinueErrorKinds).toEqual(["badGateway", "networkStream"]);
  });

  it("旧版默认 5 项应自动升级为新版全选", () => {
    expect(normalizeCodexErrorHandlingPrefs({
      autoContinueErrorKinds: ["networkStream", "rateLimited", "concurrency", "badGateway", "serviceUnavailable"],
    }).autoContinueErrorKinds).toEqual(CODEX_DEFAULT_AUTO_CONTINUE_ERROR_KINDS);
  });

  it("旧版默认 8 项应自动升级为新版全选", () => {
    expect(normalizeCodexErrorHandlingPrefs({
      autoContinueErrorKinds: ["networkStream", "rateLimited", "concurrency", "modelCapacity", "badGateway", "serviceUnavailable", "forbidden", "badRequest"],
      autoContinueErrorKindsVersion: 2,
    }).autoContinueErrorKinds).toEqual(CODEX_DEFAULT_AUTO_CONTINUE_ERROR_KINDS);
  });

  it("当前版本手动保留旧 5 项时不应反复升级", () => {
    const legacyKinds = ["networkStream", "rateLimited", "concurrency", "badGateway", "serviceUnavailable"] as const;
    const normalized = normalizeCodexErrorHandlingPrefs({
      autoContinueErrorKinds: [...legacyKinds],
      autoContinueErrorKindsVersion: CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION,
    });

    expect(normalized.autoContinueErrorKinds).toEqual([...legacyKinds]);
    expect(normalized.autoContinueErrorKindsVersion).toBe(CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION);
  });
});
