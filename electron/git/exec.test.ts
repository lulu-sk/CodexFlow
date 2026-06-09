import { describe, expect, it } from "vitest";
import { normalizeGitCommandTimeoutMs } from "./exec";

describe("git exec timeout", () => {
  it("普通 Git 命令应维持 30 分钟上限", () => {
    expect(normalizeGitCommandTimeoutMs(6 * 60 * 60_000)).toBe(30 * 60_000);
    expect(normalizeGitCommandTimeoutMs(6 * 60 * 60_000, false)).toBe(30 * 60_000);
  });

  it("显式长任务应允许 6 小时上限", () => {
    expect(normalizeGitCommandTimeoutMs(6 * 60 * 60_000, true)).toBe(6 * 60 * 60_000);
  });

  it("过小超时应提升到最小安全值", () => {
    expect(normalizeGitCommandTimeoutMs(1, false)).toBe(200);
  });
});
