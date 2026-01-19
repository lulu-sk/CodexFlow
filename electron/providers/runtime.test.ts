// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, it, expect } from "vitest";
import { resolveActiveProviderId, resolveProviderRuntimeEnvFromSettings, resolveProviderStartupCmdFromSettings } from "./runtime";

describe("providers/runtime（主进程 Provider 默认值解析）", () => {
  it("resolveActiveProviderId 在缺失时回退到 codex", () => {
    expect(resolveActiveProviderId({} as any)).toBe("codex");
    expect(resolveActiveProviderId({ providers: { activeId: "" } } as any)).toBe("codex");
    expect(resolveActiveProviderId({ providers: { activeId: "terminal" } } as any)).toBe("terminal");
  });

  it("resolveProviderStartupCmdFromSettings 支持 terminal 返回空命令（只打开 shell）", () => {
    const cfg = { terminal: "wsl", distro: "Ubuntu-24.04", codexCmd: "codex", historyRoot: "~/.codex/sessions" } as any;
    expect(resolveProviderStartupCmdFromSettings(cfg, "terminal")).toBe("");
  });

  it("resolveProviderStartupCmdFromSettings 会忽略 terminal 的 startupCmd 覆盖", () => {
    const cfg = {
      terminal: "wsl",
      distro: "Ubuntu-24.04",
      codexCmd: "codex",
      historyRoot: "~/.codex/sessions",
      providers: {
        activeId: "terminal",
        items: [{ id: "terminal", startupCmd: "codex --yolo" }],
        env: {},
      },
    } as any;
    expect(resolveProviderStartupCmdFromSettings(cfg, "terminal")).toBe("");
  });

  it("resolveProviderStartupCmdFromSettings 优先使用 providers.items 的 startupCmd（含 trim）", () => {
    const cfg = {
      terminal: "wsl",
      distro: "Ubuntu-24.04",
      codexCmd: "codex",
      historyRoot: "~/.codex/sessions",
      providers: {
        activeId: "custom-1",
        items: [{ id: "custom-1", startupCmd: "  my-engine  " }],
        env: {},
      },
    } as any;
    expect(resolveProviderStartupCmdFromSettings(cfg, "custom-1")).toBe("my-engine");
  });

  it("resolveProviderStartupCmdFromSettings 内置引擎若 startupCmd 为空则回退到默认命令", () => {
    const cfg = {
      terminal: "wsl",
      distro: "Ubuntu-24.04",
      codexCmd: "codex-x",
      historyRoot: "~/.codex/sessions",
      providers: {
        activeId: "claude",
        items: [
          { id: "claude", startupCmd: "   " },
          { id: "gemini", startupCmd: "" },
          { id: "codex", startupCmd: " " },
        ],
        env: {},
      },
    } as any;
    expect(resolveProviderStartupCmdFromSettings(cfg, "claude")).toBe("claude");
    expect(resolveProviderStartupCmdFromSettings(cfg, "gemini")).toBe("gemini");
    expect(resolveProviderStartupCmdFromSettings(cfg, "codex")).toBe("codex-x");
  });

  it("resolveProviderStartupCmdFromSettings 内置兜底：codex/claude/gemini", () => {
    const cfg = { terminal: "wsl", distro: "Ubuntu-24.04", codexCmd: "codex-x", historyRoot: "~/.codex/sessions" } as any;
    expect(resolveProviderStartupCmdFromSettings(cfg, "codex")).toBe("codex-x");
    expect(resolveProviderStartupCmdFromSettings(cfg, "claude")).toBe("claude");
    expect(resolveProviderStartupCmdFromSettings(cfg, "gemini")).toBe("gemini");
  });

  it("resolveProviderRuntimeEnvFromSettings 优先读取 providers.env，缺失时回退到 legacy 字段", () => {
    const cfg = {
      terminal: "wsl",
      distro: "Ubuntu-24.04",
      codexCmd: "codex",
      historyRoot: "~/.codex/sessions",
      providers: {
        activeId: "custom-1",
        items: [],
        env: {
          "custom-1": { terminal: "windows", distro: "Ubuntu-22.04" },
        },
      },
    } as any;
    expect(resolveProviderRuntimeEnvFromSettings(cfg, "custom-1")).toEqual({ terminal: "windows", distro: "Ubuntu-22.04" });
    expect(resolveProviderRuntimeEnvFromSettings(cfg, "missing")).toEqual({ terminal: "wsl", distro: "Ubuntu-24.04" });
  });
});
