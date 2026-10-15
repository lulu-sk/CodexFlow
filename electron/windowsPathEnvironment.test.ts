import os from "node:os";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshWindowsEnvironment } from "./windowsPathEnvironment";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

/**
 * 模拟注册表只读查询返回的路径，沿用既有路径回归用例。
 */
function mockPaths(paths: unknown, prefix = ""): void {
  vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const snapshot = Array.isArray(paths) ? { machine: { Path: paths[0] }, user: { Path: paths[1] } } : paths;
    callback(null, prefix + JSON.stringify(snapshot));
    return {};
  }) as any);
}

beforeEach(() => {
  vi.spyOn(os, "platform").mockReturnValue("win32");
  vi.mocked(execFile).mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("Windows 子进程环境刷新", () => {
  it("补入新安装路径，保留旧顺序、中文、空格和其他变量，不修改输入", async () => {
    mockPaths(["X:\\System;X:\\Tools", "X:\\工具 目录;X:\\Apps\\agy\\bin"], "\uFEFF");
    const env = { Path: "X:\\Custom;X:\\Tools;X:\\System", KEEP: "unchanged" };
    const next = await refreshWindowsEnvironment(env);
    expect(next).toEqual({ Path: env.Path + ";X:\\工具 目录;X:\\Apps\\agy\\bin", KEEP: "unchanged" });
    expect(env.Path).toBe("X:\\Custom;X:\\Tools;X:\\System");
    expect(execFile).toHaveBeenCalledWith(
      expect.stringMatching(/WindowsPowerShell\\v1\.0\\powershell\.exe$/),
      expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
      expect.objectContaining({ windowsHide: true, timeout: 3000, encoding: "utf8" }),
      expect.any(Function),
    );
  });

  it("按 Windows 路径规则去重，不调整原来的命令优先级", async () => {
    mockPaths(["x:/TOOLS/;\"X:\\Apps\\CLI\"", "X:\\New;X:/new/;;"]);
    const next = await refreshWindowsEnvironment({ PATH: "X:\\Tools;X:\\Apps\\CLI" });
    expect(next.PATH).toBe("X:\\Tools;X:\\Apps\\CLI;X:\\New");
    expect(next.Path).toBeUndefined();
  });

  it("存在大小写重复变量时只输出一个 PATH，避免子进程选中旧值", async () => {
    mockPaths(["X:\\New", null]);
    const next = await refreshWindowsEnvironment({ PATH: "X:\\First", Path: "X:\\Second" });
    expect(next).toEqual({ PATH: "X:\\First;X:\\New" });
  });

  it("无新增路径或查询数据异常时沿用原环境", async () => {
    const env = { Path: "X:\\Tools" };
    for (const paths of [["X:\\Tools", null], [], { unexpected: true }]) {
      mockPaths(paths);
      expect(await refreshWindowsEnvironment(env)).toEqual(env);
    }
  });

  it("查询超时或输出损坏时不阻止启动，后续仍可重新查询", async () => {
    const env = { Path: "X:\\Tools" };
    vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
      callback(new Error("timeout"), "");
      return {};
    }) as any);
    expect(await refreshWindowsEnvironment(env)).toBe(env);
    vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
      callback(null, "invalid json");
      return {};
    }) as any);
    expect(await refreshWindowsEnvironment(env)).toBe(env);
    mockPaths([null, "X:\\New"]);
    expect((await refreshWindowsEnvironment(env)).Path).toBe("X:\\Tools;X:\\New");
  });

  it("同时创建会话只查询一次，下一批会话仍能发现新安装的软件", async () => {
    let finish!: (error: null, output: string) => void;
    vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: typeof finish) => {
      finish = callback;
      return {};
    }) as any);
    const first = refreshWindowsEnvironment({ Path: "X:\\First" });
    const second = refreshWindowsEnvironment({ Path: "X:\\Second" });
    expect(execFile).toHaveBeenCalledTimes(1);
    finish(null, JSON.stringify({ machine: {}, user: { Path: "X:\\New" } }));
    expect((await first).Path).toBe("X:\\First;X:\\New");
    expect((await second).Path).toBe("X:\\Second;X:\\New");
    mockPaths([null, "X:\\Later"]);
    expect((await refreshWindowsEnvironment({})).Path).toBe("X:\\Later");
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("其他系统不调用 Windows 探测", async () => {
    vi.mocked(os.platform).mockReturnValue("linux");
    const env = { PATH: "/usr/bin" };
    expect(await refreshWindowsEnvironment(env)).toBe(env);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("补齐缺失的密钥和地址，用户配置优先于系统配置", async () => {
    mockPaths({
      machine: { GEMINI_API_KEY: "system-example", SHARED_VALUE: "system-example" },
      user: { GEMINI_API_KEY: "user-example", GOOGLE_GEMINI_BASE_URL: "https://api.example.test", SHARED_VALUE: "user-example" },
    });
    const env = { PROCESS_ONLY: "keep" };
    const next = await refreshWindowsEnvironment(env);
    expect(next).toMatchObject({
      GEMINI_API_KEY: "user-example",
      GOOGLE_GEMINI_BASE_URL: "https://api.example.test",
      SHARED_VALUE: "user-example",
      PROCESS_ONLY: "keep",
    });
    expect(env).toEqual({ PROCESS_ONLY: "keep" });
  });

  it("按 Windows 大小写规则保留父进程临时值，不被持久配置覆盖", async () => {
    mockPaths({ machine: { Gemini_Api_Key: "system-example" }, user: { gemini_api_key: "user-example", EMPTY: "", INVALID: 7 } });
    const next = await refreshWindowsEnvironment({ GEMINI_API_KEY: "old-example", EMPTY: "old" });
    expect(next).toEqual({ GEMINI_API_KEY: "old-example", EMPTY: "old" });
    expect(Object.keys(next).filter((key) => key.toLowerCase() === "gemini_api_key")).toHaveLength(1);
  });

  it("保留父进程明确设置的空密钥和空 PATH", async () => {
    mockPaths({
      machine: { Path: "X:\\System", GEMINI_API_KEY: "system-example" },
      user: { Path: "X:\\Apps\\agy\\bin", gemini_api_key: "user-example" },
    });
    const env = { PATH: "", GEMINI_API_KEY: "" };
    expect(await refreshWindowsEnvironment(env)).toEqual(env);
  });

  it("未定义的变量按缺失处理，仍能补入用户配置", async () => {
    mockPaths({ machine: { GEMINI_API_KEY: "system-example" }, user: { gemini_api_key: "user-example" } });
    const next = await refreshWindowsEnvironment({ GEMINI_API_KEY: undefined });
    expect(next).toEqual({ GEMINI_API_KEY: "user-example" });
  });

  it("补入的用户空值可覆盖系统默认值", async () => {
    mockPaths({ machine: { EXAMPLE_TOKEN: "system-example" }, user: { example_token: "" } });
    expect(await refreshWindowsEnvironment({})).toEqual({ EXAMPLE_TOKEN: "" });
  });

  it("读取失败或结构无效时保留完整原环境", async () => {
    const env = { Path: "X:\\Tools", GEMINI_API_KEY: "process-example" };
    for (const snapshot of [null, { machine: {}, user: [] }, { machine: null, user: {} }]) {
      mockPaths(snapshot);
      expect(await refreshWindowsEnvironment(env)).toBe(env);
    }
  });
});
