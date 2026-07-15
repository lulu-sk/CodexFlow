import { describe, expect, it } from "vitest";
import {
  areProviderEnvironmentsEqual,
  isCurrentProviderEnvironmentRequest,
} from "./environment";

describe("Provider 环境切换", () => {
  it("应忽略较早完成的异步环境检查", () => {
    expect(isCurrentProviderEnvironmentRequest(
      { providerId: "codex", sequence: 1 },
      "codex",
      2,
    )).toBe(false);
  });

  it("切换 Provider 后不应提交旧 Provider 的检查结果", () => {
    expect(isCurrentProviderEnvironmentRequest(
      { providerId: "codex", sequence: 2 },
      "claude",
      2,
    )).toBe(false);
  });

  it("最后一次选择应允许提交且发行版比较不区分大小写", () => {
    expect(isCurrentProviderEnvironmentRequest(
      { providerId: "codex", sequence: 3 },
      "codex",
      3,
    )).toBe(true);
    expect(areProviderEnvironmentsEqual(
      { terminal: "wsl", distro: "Ubuntu-24.04" },
      { terminal: "wsl", distro: "ubuntu-24.04" },
    )).toBe(true);
  });
});
