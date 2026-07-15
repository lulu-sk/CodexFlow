import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { WslConptyPty } from "./wslConpty";

/** 创建可观察委托行为的最小 PTY 桩。 */
function createPtyStub(): IPty {
  return {
    pid: 42,
    cols: 120,
    rows: 30,
    process: "wsl.exe",
    handleFlowControl: false,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

/** 向 WSL ConPTY 包装层触发一段底层 PTY 输出。 */
function emitPtyData(pty: IPty, data: string): void {
  const calls = (pty.onData as any).mock.calls as Array<[(data: string) => void]>;
  const listener = calls[0]?.[0];
  if (!listener)
    throw new Error("missing inner PTY data listener");
  listener(data);
}

/** 向 WSL ConPTY 包装层触发底层 PTY 退出事件。 */
function emitPtyExit(pty: IPty, exitCode = 0): void {
  const calls = (pty.onExit as any).mock.calls as Array<[
    (event: { exitCode: number }) => void,
  ]>;
  const listener = calls[0]?.[0];
  if (!listener)
    throw new Error("missing inner PTY exit listener");
  listener({ exitCode });
}

/** 创建统一的 WSL PTY 启动参数。 */
function createOptions(spawn: ReturnType<typeof vi.fn>, frontendReadyTimeoutMs?: number) {
  return {
    file: "wsl.exe",
    args: ["-d", "Ubuntu"],
    ptyOptions: {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env: { TERM: "xterm-256color" },
    },
    frontendReadyTimeoutMs,
    spawn: spawn as any,
  };
}

describe("WslConptyPty", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("应优先启用应用内置 ConPTY", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));

    expect(terminal.backend).toBe("bundled");
    expect(terminal.fallbackReason).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", "Ubuntu"],
      expect.objectContaining({ useConpty: true, useConptyDll: true }),
    );
  });

  it("内置 ConPTY 同步启动失败时应退回系统 ConPTY", () => {
    const inner = createPtyStub();
    const onFallback = vi.fn();
    const spawn = vi.fn()
      .mockImplementationOnce(() => { throw new Error("bundled conpty unavailable"); })
      .mockReturnValueOnce(inner);
    const terminal = new WslConptyPty({
      ...createOptions(spawn),
      onFallback,
    });

    expect(terminal.backend).toBe("system");
    expect(terminal.fallbackReason).toBe("bundled conpty unavailable");
    expect(onFallback).toHaveBeenCalledWith("bundled conpty unavailable");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ useConpty: true, useConptyDll: false }),
    );
  });

  it("自动启动命令应等待前端完成绑定", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));

    terminal.writeWhenFrontendReady("bash -lc codex\r");
    expect(inner.write).not.toHaveBeenCalled();

    terminal.markFrontendReady();
    expect(inner.write).toHaveBeenCalledWith("bash -lc codex\r");

    terminal.writeWhenFrontendReady("echo ready\r");
    expect(inner.write).toHaveBeenLastCalledWith("echo ready\r");
  });

  it("前端未发送就绪事件时应按超时兜底启动", () => {
    vi.useFakeTimers();
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn, 25));

    terminal.writeWhenFrontendReady("bash -lc codex\r");
    vi.advanceTimersByTime(24);
    expect(inner.write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(inner.write).toHaveBeenCalledWith("bash -lc codex\r");
  });

  it("应在主进程直接回答 OSC 10/11 查询并阻止查询重复进入 xterm", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));
    const output = vi.fn();
    terminal.onData(output);
    terminal.markFrontendReady({
      foreground: "#123456",
      background: "#ABCDEF",
    });

    emitPtyData(
      inner,
      `before\x1B]10;?\x1B\\middle\x1B]11;?\x1B\\after`,
    );

    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith("beforemiddleafter");
    expect(inner.write).toHaveBeenNthCalledWith(
      1,
      "\x1B]10;rgb:1212/3434/5656\x1B\\",
    );
    expect(inner.write).toHaveBeenNthCalledWith(
      2,
      "\x1B]11;rgb:abab/cdcd/efef\x1B\\",
    );
  });

  it("OSC 10/11 查询跨多个 PTY 数据块时仍应稳定回答", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));
    const output = vi.fn();
    terminal.onData(output);
    terminal.markFrontendReady({
      foreground: "#102030",
      background: "#405060",
    });

    emitPtyData(inner, "普通\x1B]1");
    emitPtyData(inner, "0;?\x1B");
    emitPtyData(inner, "\\输出\x1B]11;?");
    emitPtyData(inner, "\x07完成");

    expect(output.mock.calls.map(([data]) => data).join("")).toBe("普通输出完成");
    expect(inner.write).toHaveBeenNthCalledWith(
      1,
      "\x1B]10;rgb:1010/2020/3030\x1B\\",
    );
    expect(inner.write).toHaveBeenNthCalledWith(
      2,
      "\x1B]11;rgb:4040/5050/6060\x1B\\",
    );
  });

  it("前端画面暂停期间仍应读取并立即回答颜色查询", () => {
    vi.useFakeTimers();
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const onDiagnostic = vi.fn();
    const terminal = new WslConptyPty({
      ...createOptions(spawn),
      onDiagnostic,
    });
    const output = vi.fn();
    terminal.onData(output);
    terminal.markFrontendReady({
      foreground: "#123456",
      background: "#ABCDEF",
    });

    terminal.pause();
    terminal.pause();
    emitPtyData(inner, "before\x1B]1");
    emitPtyData(inner, "0;?\x1B");
    emitPtyData(inner, "\\middle\x1B]11;?");
    emitPtyData(inner, "\x07after");

    expect(inner.pause).not.toHaveBeenCalled();
    expect(inner.write).toHaveBeenNthCalledWith(
      1,
      "\x1B]10;rgb:1212/3434/5656\x1B\\",
    );
    expect(inner.write).toHaveBeenNthCalledWith(
      2,
      "\x1B]11;rgb:abab/cdcd/efef\x1B\\",
    );
    expect(output).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onDiagnostic).toHaveBeenCalledWith(
      "osc-query slot=11 frontendPaused=1",
    );

    terminal.resume();
    terminal.resume();

    expect(inner.resume).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith("beforemiddleafter");
  });

  it("暂停缓存达到上限时应无损直通且不暂停底层 socket", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));
    const output = vi.fn();
    terminal.onData(output);
    terminal.markFrontendReady();
    terminal.pause();
    const largeOutput = "x".repeat(200_000);

    emitPtyData(inner, largeOutput);

    expect(inner.pause).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith(largeOutput);
    terminal.resume();
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("暂停状态退出时应先释放普通输出和未决协议前缀", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));
    const order: string[] = [];
    terminal.onData((data) => order.push(`data:${data}`));
    terminal.onExit(() => order.push("exit"));
    terminal.markFrontendReady();
    terminal.pause();

    emitPtyData(inner, "output\x1B");
    emitPtyExit(inner);

    expect(order).toEqual(["data:output\x1B", "exit"]);
  });

  it("非颜色查询及前端就绪前的输出应保持原样", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));
    const output = vi.fn();
    terminal.onData(output);

    emitPtyData(inner, "\x1B]10;?\x1B\\");
    terminal.markFrontendReady();
    emitPtyData(inner, "\x1B]1");
    emitPtyData(inner, "2;?\x1B\\");

    expect(output.mock.calls.map(([data]) => data).join("")).toBe(
      "\x1B]10;?\x1B\\\x1B]12;?\x1B\\",
    );
    expect(inner.write).not.toHaveBeenCalled();
  });

  it("非法主题色应回退到 Campbell 默认色且不能注入终端协议", () => {
    const inner = createPtyStub();
    const spawn = vi.fn(() => inner);
    const terminal = new WslConptyPty(createOptions(spawn));
    terminal.markFrontendReady({
      foreground: "red\x1B]52;bad",
      background: "#010203",
    });

    emitPtyData(inner, "\x1B]10;?\x07\x1B]11;?\x07");

    expect(inner.write).toHaveBeenNthCalledWith(
      1,
      "\x1B]10;rgb:cccc/cccc/cccc\x1B\\",
    );
    expect(inner.write).toHaveBeenNthCalledWith(
      2,
      "\x1B]11;rgb:0101/0202/0303\x1B\\",
    );
  });
});
