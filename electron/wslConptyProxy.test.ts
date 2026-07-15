import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WslConptyHostCommand } from "./wslConptyProtocol";
import {
  spawnIsolatedWslConpty,
  type ForkWslConptyHost,
  type WslConptyHostProcess,
} from "./wslConptyProxy";

type FakeHost = EventEmitter & WslConptyHostProcess & {
  posted: WslConptyHostCommand[];
};

/** 创建可观察命令并主动模拟宿主事件的工具进程桩。 */
function createFakeHost(): FakeHost {
  const host = new EventEmitter() as FakeHost;
  host.posted = [];
  host.postMessage = vi.fn((command: WslConptyHostCommand) => {
    host.posted.push(command);
    if (command.type !== "init")
      return;
    queueMicrotask(() => {
      host.emit("message", {
        type: "ready",
        pid: 42,
        cols: 120,
        rows: 30,
        process: "wsl.exe",
        handleFlowControl: false,
        backend: "bundled",
      });
    });
  });
  host.kill = vi.fn(() => true);
  return host;
}

/** 创建统一的隔离 WSL PTY 启动参数。 */
function createOptions(onDiagnostic = vi.fn(), onFallback = vi.fn()) {
  return {
    file: "wsl.exe",
    args: ["-d", "Ubuntu"],
    ptyOptions: {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env: { TERM: "xterm-256color" },
    },
    onDiagnostic,
    onFallback,
  };
}

/** 创建会在下一微任务报告 spawn 的宿主工厂。 */
function createFork(host: FakeHost): ForkWslConptyHost {
  return vi.fn(() => {
    queueMicrotask(() => host.emit("spawn"));
    return host;
  });
}

describe("IsolatedWslConptyPty", () => {
  it("应等待独立宿主就绪并保留 WSL ConPTY 元数据", async () => {
    const host = createFakeHost();
    const fork = createFork(host);
    const terminal = await spawnIsolatedWslConpty(createOptions(), fork);

    expect(fork).toHaveBeenCalledTimes(1);
    expect(host.posted[0]).toEqual(expect.objectContaining({
      type: "init",
      file: "wsl.exe",
      args: ["-d", "Ubuntu"],
    }));
    expect(terminal.pid).toBe(42);
    expect(terminal.cols).toBe(120);
    expect(terminal.rows).toBe(30);
    expect(terminal.process).toBe("wsl.exe");
    expect(terminal.backend).toBe("bundled");
  });

  it("应在主进程代理与独立宿主之间完整转发 PTY 协议", async () => {
    const host = createFakeHost();
    const onDiagnostic = vi.fn();
    const onFallback = vi.fn();
    const terminal = await spawnIsolatedWslConpty(
      createOptions(onDiagnostic, onFallback),
      createFork(host),
    );
    const onData = vi.fn();
    const onExit = vi.fn();
    terminal.onData(onData);
    terminal.onExit(onExit);

    terminal.markFrontendReady({ foreground: "#CCCCCC", background: "#0C0C0C" });
    terminal.writeWhenFrontendReady("bash -lc codex\r");
    terminal.write("input");
    terminal.pause();
    terminal.resize(100, 24);
    terminal.resume();
    terminal.clear();

    expect(host.posted).toEqual(expect.arrayContaining([
      {
        type: "frontend-ready",
        colors: { foreground: "#CCCCCC", background: "#0C0C0C" },
      },
      { type: "write-when-ready", data: "bash -lc codex\r" },
      { type: "write", data: "input" },
      { type: "pause" },
      { type: "resize", columns: 100, rows: 24 },
      { type: "resume" },
      { type: "clear" },
    ]));

    host.emit("message", { type: "data", data: "output" });
    host.emit("message", { type: "diagnostic", message: "osc-query slot=11" });
    host.emit("message", { type: "fallback", reason: "bundled unavailable" });
    host.emit("message", { type: "exit", exitCode: 0 });

    expect(onData).toHaveBeenCalledWith("output");
    expect(onDiagnostic).toHaveBeenCalledWith("osc-query slot=11");
    expect(onFallback).toHaveBeenCalledWith("bundled unavailable");
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: undefined });
  });

  it("宿主初始化失败时应拒绝创建而不是留下半连接会话", async () => {
    const host = createFakeHost();
    host.postMessage = vi.fn((command: WslConptyHostCommand) => {
      host.posted.push(command);
      if (command.type === "init") {
        queueMicrotask(() => {
          host.emit("message", { type: "init-error", error: "ConPTY unavailable" });
        });
      }
    });

    await expect(
      spawnIsolatedWslConpty(createOptions(), createFork(host)),
    ).rejects.toThrow("ConPTY unavailable");
    expect(host.kill).toHaveBeenCalledTimes(1);
  });

  it("PTY 未返回退出事件时应超时强制回收工具进程", async () => {
    vi.useFakeTimers();
    try {
      const host = createFakeHost();
      const terminalPromise = spawnIsolatedWslConpty(createOptions(), createFork(host));
      vi.runAllTicks();
      const terminal = await terminalPromise;

      terminal.kill();

      expect(host.posted).toContainEqual({ type: "kill", signal: undefined });
      expect(host.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(host.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("收到 PTY 退出事件后应立即回收宿主且不重复上报退出", async () => {
    const host = createFakeHost();
    const terminal = await spawnIsolatedWslConpty(createOptions(), createFork(host));
    const onExit = vi.fn();
    terminal.onExit(onExit);

    host.emit("message", { type: "exit", exitCode: 0 });
    host.emit("exit", 4294967295);

    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: undefined });
  });
});
