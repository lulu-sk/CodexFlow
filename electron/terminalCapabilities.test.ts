import { describe, expect, it } from "vitest";
import {
  applyTerminalCapabilityEnvironment,
  normalizeTerminalCapabilitySettings,
  sanitizeInheritedTerminalColorEnvironment,
} from "./terminalCapabilities";

describe("terminalCapabilities", () => {
  it("旧设置应默认启用兼容性补齐并关闭真彩色注入", () => {
    expect(normalizeTerminalCapabilitySettings(undefined)).toEqual({
      normalizeTerm: true,
      trueColor: false,
    });
  });

  it("应清理 dumb 父进程临时注入的禁色变量", () => {
    expect(sanitizeInheritedTerminalColorEnvironment({
      TERM: "dumb",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "1",
    })).toEqual({ TERM: "dumb" });
  });

  it("父进程已是交互终端时应保留用户颜色控制变量", () => {
    expect(sanitizeInheritedTerminalColorEnvironment({
      TERM: "xterm-256color",
      NO_COLOR: "1",
    })).toEqual({ TERM: "xterm-256color", NO_COLOR: "1" });
  });

  it.each([undefined, "", "dumb", "DUMB"])("应把退化 TERM=%s 补齐为 xterm-256color", (term) => {
    const env = applyTerminalCapabilityEnvironment(
      term === undefined ? {} : { TERM: term },
      { normalizeTerm: true, trueColor: false },
    );
    expect(env.TERM).toBe("xterm-256color");
  });

  it("应保留用户已有的有效 TERM", () => {
    const env = applyTerminalCapabilityEnvironment(
      { TERM: "screen-256color" },
      { normalizeTerm: true },
    );
    expect(env.TERM).toBe("screen-256color");
  });

  it("关闭兼容性补齐后应保留 dumb", () => {
    const env = applyTerminalCapabilityEnvironment(
      { TERM: "dumb" },
      { normalizeTerm: false },
    );
    expect(env.TERM).toBe("dumb");
  });

  it("开启真彩色后应仅在缺失时注入 COLORTERM", () => {
    expect(applyTerminalCapabilityEnvironment({}, { trueColor: true }).COLORTERM).toBe("truecolor");
    expect(applyTerminalCapabilityEnvironment(
      { COLORTERM: "24bit" },
      { trueColor: true },
    ).COLORTERM).toBe("24bit");
  });

  it("存在 NO_COLOR 时不应注入真彩色声明", () => {
    const env = applyTerminalCapabilityEnvironment(
      { NO_COLOR: "" },
      { trueColor: true },
    );
    expect(env.COLORTERM).toBeUndefined();
  });
});
