import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveGeminiImageDirWinPath,
  resolveGeminiProjectIdentifier,
  resolveGeminiProjectTempRootWinPath,
} from "./projectTemp";
import { getDistroHomeSubPathUNCAsync } from "../wsl";

vi.mock("../wsl", () => ({
  getDistroHomeSubPathUNCAsync: vi.fn(),
}));

/**
 * 中文说明：创建临时测试目录，并确保用例结束后清理。
 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Gemini 项目临时目录解析", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    try { vi.restoreAllMocks(); } catch {}
    try { vi.unstubAllEnvs(); } catch {}
    delete process.env.GEMINI_CLI_HOME;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("优先读取 projects.json 中已存在的 shortId 映射", async () => {
    const geminiHome = createTempDir("gemini-home-");
    tempDirs.push(geminiHome);
    process.env.GEMINI_CLI_HOME = geminiHome;

    const normalizedProjectRoot = "g:\\projects\\demo";
    await fsp.mkdir(path.join(geminiHome, "tmp"), { recursive: true });
    await fsp.writeFile(
      path.join(geminiHome, "projects.json"),
      JSON.stringify({ projects: { [normalizedProjectRoot]: "demo-app" } }),
      "utf8",
    );

    const projectId = await resolveGeminiProjectIdentifier({
      projectWinRoot: "G:\\Projects\\demo",
      runtimeEnv: "windows",
    });

    expect(projectId).toBe("demo-app");
  });

  it("registry 缺失时会根据 marker 反查 shortId", async () => {
    const geminiHome = createTempDir("gemini-home-");
    tempDirs.push(geminiHome);
    process.env.GEMINI_CLI_HOME = geminiHome;

    const markerDir = path.join(geminiHome, "tmp", "demo-worktree");
    await fsp.mkdir(markerDir, { recursive: true });
    await fsp.writeFile(path.join(markerDir, ".project_root"), "/home/lulu/demo", "utf8");

    const projectId = await resolveGeminiProjectIdentifier({
      projectWslRoot: "/home/lulu/demo",
      runtimeEnv: "wsl",
    });

    expect(projectId).toBe("demo-worktree");
  });

  it("无 registry/marker 时会按 Gemini slug 规则声明新的 shortId", async () => {
    const geminiHome = createTempDir("gemini-home-");
    tempDirs.push(geminiHome);
    process.env.GEMINI_CLI_HOME = geminiHome;

    const projectId = await resolveGeminiProjectIdentifier({
      projectWinRoot: "G:\\Projects\\My Demo",
      runtimeEnv: "windows",
    });

    expect(projectId).toBe("my-demo");
    expect(fs.existsSync(path.join(geminiHome, "tmp", "my-demo", ".project_root"))).toBe(true);
  });

  it("WSL 运行时将 Gemini temp 目录解析为 UNC 路径", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32" as any);
    vi.mocked(getDistroHomeSubPathUNCAsync).mockResolvedValue("\\\\wsl.localhost\\Ubuntu-24.04\\home\\lulu\\.gemini");
    const originalReadFile = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, "readFile").mockImplementation(async (targetPath: any, ...args: any[]) => {
      const normalizedPath = String(targetPath || "");
      if (normalizedPath === "\\\\wsl.localhost\\Ubuntu-24.04\\home\\lulu\\.gemini\\projects.json")
        return JSON.stringify({ projects: { "/home/lulu/demo": "demo" } }) as any;
      return await (originalReadFile as any)(targetPath, ...args);
    });

    const tempRoot = await resolveGeminiProjectTempRootWinPath({
      projectWslRoot: "/home/lulu/demo",
      runtimeEnv: "wsl",
      distro: "Ubuntu-24.04",
    });
    const imageRoot = await resolveGeminiImageDirWinPath({
      projectWslRoot: "/home/lulu/demo",
      runtimeEnv: "wsl",
      distro: "Ubuntu-24.04",
    });

    expect(tempRoot).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\lulu\\.gemini\\tmp\\demo");
    expect(imageRoot).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\lulu\\.gemini\\tmp\\demo\\images");
  });

  it("Windows 主进程在 WSL 模式下会把 POSIX 版 GEMINI_CLI_HOME 转成 UNC", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32" as any);
    process.env.GEMINI_CLI_HOME = "/home/lulu/.gemini-custom";
    const originalReadFile = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, "readFile").mockImplementation(async (targetPath: any, ...args: any[]) => {
      const normalizedPath = String(targetPath || "");
      if (normalizedPath === "\\\\wsl.localhost\\Ubuntu-24.04\\home\\lulu\\.gemini-custom\\projects.json")
        return JSON.stringify({ projects: { "/home/lulu/demo": "demo" } }) as any;
      return await (originalReadFile as any)(targetPath, ...args);
    });

    const tempRoot = await resolveGeminiProjectTempRootWinPath({
      projectWslRoot: "/home/lulu/demo",
      runtimeEnv: "wsl",
      distro: "Ubuntu-24.04",
    });

    expect(tempRoot).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\lulu\\.gemini-custom\\tmp\\demo");
  });
});
