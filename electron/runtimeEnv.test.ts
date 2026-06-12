import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./wsl.js", () => ({
  default: {
    listDistrosAsync: vi.fn(),
    execInWslAsync: vi.fn(),
  },
}));

vi.mock("./shells.js", () => ({
  hasPwsh: vi.fn(),
  normalizeTerminal: (raw: unknown) => {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (value === "pwsh") return "pwsh";
    if (value === "cmd") return "cmd";
    if (value === "windows") return "windows";
    return "wsl";
  },
  pickVisibleWindowsTerminalMode: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import wsl from "./wsl.js";
import { execFile } from "node:child_process";
import { hasPwsh, pickVisibleWindowsTerminalMode } from "./shells.js";
import { checkRuntimeCli, clearRuntimeEnvProbeCachesForTest, extractRuntimeCliName, resolveVisibleRuntimeEnv } from "./runtimeEnv";

const mockedWsl = vi.mocked(wsl);
const mockedExecFile = vi.mocked(execFile as any);
const mockedHasPwsh = vi.mocked(hasPwsh);
const mockedPickVisibleWindowsTerminalMode = vi.mocked(pickVisibleWindowsTerminalMode);
const originalPlatform = process.platform;

describe("resolveVisibleRuntimeEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRuntimeEnvProbeCachesForTest();
    Object.defineProperty(process, "platform", { value: "win32" });
    mockedPickVisibleWindowsTerminalMode.mockResolvedValue("pwsh");
    mockedHasPwsh.mockResolvedValue(true);
    mockedExecFile.mockImplementation((_file: string, _args: string[], _options: any, callback: (error: Error | null) => void) => {
      callback(null);
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("WSL 不可用时回退到可见的 Windows shell", async () => {
    mockedWsl.listDistrosAsync.mockResolvedValue([]);

    const result = await resolveVisibleRuntimeEnv({ terminal: "wsl", distro: "Ubuntu-24.04" });

    expect(result.terminal).toBe("pwsh");
    expect(result.distro).toBe("Ubuntu-24.04");
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("wsl_unavailable");
  });

  it("请求的 WSL 发行版不存在时选择可用 Ubuntu 发行版", async () => {
    mockedWsl.listDistrosAsync.mockResolvedValue([
      { name: "Ubuntu-22.04" },
      { name: "Ubuntu-24.04" },
    ]);

    const result = await resolveVisibleRuntimeEnv({ terminal: "wsl", distro: "Missing" });

    expect(result.terminal).toBe("wsl");
    expect(result.distro).toBe("Ubuntu-24.04");
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("wsl_distro_unavailable");
  });

  it("PowerShell 7 不可用时回退到 Windows PowerShell", async () => {
    mockedWsl.listDistrosAsync.mockResolvedValue([{ name: "Ubuntu-24.04" }]);
    mockedHasPwsh.mockResolvedValue(false);

    const result = await resolveVisibleRuntimeEnv({ terminal: "pwsh", distro: "Ubuntu-24.04" });

    expect(result.terminal).toBe("windows");
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("pwsh_unavailable");
  });
});

describe("extractRuntimeCliName", () => {
  it("提取普通启动命令的 CLI 名称", () => {
    expect(extractRuntimeCliName("codex --yolo")).toBe("codex");
  });

  it("跳过 WSL 环境变量前缀", () => {
    expect(extractRuntimeCliName("RUST_LOG=codex_tui=trace codex")).toBe("codex");
  });

  it("跳过 PowerShell 环境变量前缀", () => {
    expect(extractRuntimeCliName("$env:RUST_LOG='codex_tui=trace'; codex")).toBe("codex");
  });

  it("跳过 cmd 环境变量前缀", () => {
    expect(extractRuntimeCliName('set "RUST_LOG=codex_tui=trace" && codex')).toBe("codex");
  });

  it("跳过 PowerShell 调用操作符并保留 Windows 路径反斜杠", () => {
    expect(extractRuntimeCliName('& "C:\\Program Files\\Codex\\codex.exe" --yolo')).toBe("C:\\Program Files\\Codex\\codex.exe");
  });
});

describe("checkRuntimeCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRuntimeEnvProbeCachesForTest();
    mockedWsl.listDistrosAsync.mockResolvedValue([]);
    mockedPickVisibleWindowsTerminalMode.mockResolvedValue("pwsh");
    mockedHasPwsh.mockResolvedValue(true);
    mockedExecFile.mockImplementation((_file: string, _args: string[], _options: any, callback: (error: Error | null) => void) => {
      callback(null);
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("非 Windows 宿主检测 CLI 时使用 POSIX command -v", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    const result = await checkRuntimeCli({ terminal: "windows", startupCmd: "codex --yolo" });

    expect(result.ok).toBe(true);
    expect(result.cli).toBe("codex");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "sh",
      ["-lc", "command -v -- 'codex' >/dev/null 2>&1"],
      expect.objectContaining({ timeout: 2500, windowsHide: true }),
      expect.any(Function),
    );
    expect(mockedExecFile).not.toHaveBeenCalledWith(
      "where.exe",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("连续检查相同宿主 CLI 时复用短期缓存", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    const first = await checkRuntimeCli({ terminal: "windows", startupCmd: "codex --yolo" });
    const second = await checkRuntimeCli({ terminal: "windows", startupCmd: "codex --yolo" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it("并发检查相同 WSL CLI 时合并为一次 WSL 命令", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockedWsl.listDistrosAsync.mockResolvedValue([{ name: "Ubuntu-24.04" }]);
    vi.mocked((mockedWsl as any).execInWslAsync).mockResolvedValue("yes");

    const [first, second] = await Promise.all([
      checkRuntimeCli({ terminal: "wsl", distro: "Ubuntu-24.04", startupCmd: "codex --yolo" }),
      checkRuntimeCli({ terminal: "wsl", distro: "Ubuntu-24.04", startupCmd: "codex --yolo" }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(mockedWsl.listDistrosAsync).toHaveBeenCalledTimes(1);
    expect((mockedWsl as any).execInWslAsync).toHaveBeenCalledTimes(1);
  });
});
