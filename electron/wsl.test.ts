import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import { isUNCPath, uncToWsl, winToWsl, wslToUNC, normalizeWinPath } from "./wsl";

describe("wsl 路径工具（UNC 兼容）", () => {
  afterEach(() => {
    try { vi.restoreAllMocks(); } catch {}
  });

  it("isUNCPath 识别 \\\\wsl.localhost 与 \\\\wsl$ 前缀", () => {
    expect(isUNCPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj")).toBe(true);
    expect(isUNCPath("\\\\wsl$\\Ubuntu-24.04\\home\\me\\proj")).toBe(true);
    expect(isUNCPath("\\\\WSL$\\Ubuntu-24.04\\home\\me\\proj")).toBe(true);
    expect(isUNCPath("\\\\server\\share\\path")).toBe(false);
  });

  it("uncToWsl 能从 \\\\wsl.localhost/\\\\wsl$ 解析出 distro 与 wslPath", () => {
    expect(uncToWsl("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj")).toEqual({
      distro: "Ubuntu-24.04",
      wslPath: "/home/me/proj",
    });
    expect(uncToWsl("\\\\wsl$\\Ubuntu-24.04\\home\\me\\proj")).toEqual({
      distro: "Ubuntu-24.04",
      wslPath: "/home/me/proj",
    });
  });

  it("winToWsl 在 win32 下可直接把 WSL UNC 转为 /home/...", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32" as any);
    expect(winToWsl("\\\\wsl$\\Ubuntu-24.04\\home\\me\\proj")).toBe("/home/me/proj");
    expect(winToWsl("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj")).toBe("/home/me/proj");
  });

  it("wslToUNC 输出标准 UNC（单反斜杠分隔）", () => {
    expect(wslToUNC("/home/me/proj", "Ubuntu-24.04")).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj");
  });

  it("normalizeWinPath 可去除 PowerShell Provider/长路径前缀", () => {
    expect(normalizeWinPath("Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\me\\proj")).toBe("C:\\Users\\me\\proj");
    expect(normalizeWinPath("\\\\?\\C:\\Users\\me\\proj")).toBe("C:\\Users\\me\\proj");
    expect(normalizeWinPath("\\\\?\\UNC\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj")).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj");
  });
});
