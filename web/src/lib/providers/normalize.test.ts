import { describe, expect, it } from "vitest";
import { coerceRendererTerminalMode, normalizeProvidersSettings } from "./normalize";

describe("providers/normalize（跨平台终端模式收口）", () => {
  it("Windows 渲染层会把 native 回退为默认终端", () => {
    expect(coerceRendererTerminalMode("native", "wsl")).toBe("wsl");
  });

  it("macOS/Linux 渲染层会把 Windows/WSL 模式回退为 native", () => {
    expect(coerceRendererTerminalMode("windows", "native")).toBe("native");
    expect(coerceRendererTerminalMode("wsl", "native")).toBe("native");
  });

  it("normalizeProvidersSettings 会在 Windows 默认值下清理 native 配置", () => {
    const normalized = normalizeProvidersSettings(
      {
        activeId: "codex",
        items: [{ id: "codex" }],
        env: {
          codex: {
            terminal: "native",
            distro: "",
            shell: "/bin/zsh",
          },
        },
      },
      {
        terminal: "wsl",
        distro: "Ubuntu-24.04",
        codexCmd: "codex",
      },
    );

    expect(normalized.env.codex.terminal).toBe("wsl");
    expect(normalized.env.codex.distro).toBe("Ubuntu-24.04");
  });
});
