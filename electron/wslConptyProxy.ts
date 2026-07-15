// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { utilityProcess } from "electron";
import type { IEvent, IPty } from "node-pty";
import type {
  TerminalPaletteColors,
  WslConptyBackend,
  WslConptyOptions,
} from "./wslConpty.js";
import type {
  WslConptyHostCommand,
  WslConptyHostEvent,
} from "./wslConptyProtocol.js";

const WSL_HOST_START_TIMEOUT_MS = 10_000;
const WSL_HOST_KILL_TIMEOUT_MS = 1_000;

export type WslConptyHostProcess = {
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: WslConptyHostCommand): void;
  kill(): boolean;
};

export type ForkWslConptyHost = (modulePath: string) => WslConptyHostProcess;

/** 创建 Electron utility process 作为单个 WSL PTY 的隔离宿主。 */
function forkDefaultHost(modulePath: string): WslConptyHostProcess {
  return utilityProcess.fork(modulePath, [], {
    serviceName: "CodexFlow WSL PTY",
    stdio: "ignore",
  }) as unknown as WslConptyHostProcess;
}

/** 返回编译后的 WSL PTY 工具进程入口。 */
function resolveHostModulePath(): string {
  return path.join(__dirname, "wslConptyHost.js");
}

/** 把未知宿主错误转换为可读文本。 */
function describeHostError(error: unknown): string {
  if (error instanceof Error && error.message)
    return error.message;
  return String(error || "unknown WSL PTY host error");
}

/**
 * 在主进程中代理独立 WSL PTY 宿主，终端协议解析与回复始终留在工具进程内。
 */
export class IsolatedWslConptyPty implements IPty {
  private readonly host: WslConptyHostProcess;
  private readonly onFallback?: (reason: string) => void;
  private readonly onDiagnostic?: (message: string) => void;
  private readonly dataListeners = new Set<(data: string) => unknown>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => unknown>();
  private earlyData: string[] = [];
  private pendingExit: { exitCode: number; signal?: number } | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private initialized = false;
  private exited = false;
  private hostTerminated = false;
  private hostKillTimer: NodeJS.Timeout | null = null;
  private currentPid = 0;
  private currentCols: number;
  private currentRows: number;
  private currentProcess = "wsl.exe";
  private flowControl = false;

  public backend: WslConptyBackend = "bundled";
  public fallbackReason?: string;

  /** 创建一个尚未完成宿主握手的 WSL PTY 代理。 */
  constructor(
    host: WslConptyHostProcess,
    options: Pick<WslConptyOptions, "ptyOptions" | "onFallback" | "onDiagnostic">,
  ) {
    this.host = host;
    this.onFallback = options.onFallback;
    this.onDiagnostic = options.onDiagnostic;
    this.currentCols = options.ptyOptions.cols ?? 80;
    this.currentRows = options.ptyOptions.rows ?? 24;
    this.host.on("message", (message) => this.handleHostEvent(message));
    this.host.once("exit", (code) => this.handleHostExit(code));
  }

  /** 启动工具进程内的 WSL ConPTY，并等待其返回元数据。 */
  public initialize(options: WslConptyOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      const timer = setTimeout(() => {
        this.rejectInitialization(new Error("WSL PTY host startup timed out"));
        this.terminateHost();
      }, WSL_HOST_START_TIMEOUT_MS);
      try { timer.unref(); } catch {}
      const finishResolve = this.initResolve;
      const finishReject = this.initReject;
      this.initResolve = () => {
        clearTimeout(timer);
        finishResolve?.();
      };
      this.initReject = (error) => {
        clearTimeout(timer);
        finishReject?.(error);
      };
      this.host.once("spawn", () => {
        this.postCommand({
          type: "init",
          file: options.file,
          args: options.args,
          ptyOptions: options.ptyOptions,
          frontendReadyTimeoutMs: options.frontendReadyTimeoutMs,
        });
      });
    });
  }

  /** 返回工具进程持有的 WSL PTY 进程编号。 */
  public get pid(): number {
    return this.currentPid;
  }

  /** 返回当前终端列数。 */
  public get cols(): number {
    return this.currentCols;
  }

  /** 返回当前终端行数。 */
  public get rows(): number {
    return this.currentRows;
  }

  /** 返回底层活动进程名称。 */
  public get process(): string {
    return this.currentProcess;
  }

  /** 返回当前流控制开关。 */
  public get handleFlowControl(): boolean {
    return this.flowControl;
  }

  /** 同步设置工具进程内 PTY 的流控制开关。 */
  public set handleFlowControl(value: boolean) {
    this.flowControl = value;
    this.postCommand({ type: "flow-control", enabled: value });
  }

  /** 注册工具进程转发的终端输出监听器。 */
  public readonly onData: IEvent<string> = (listener) => {
    this.dataListeners.add(listener);
    if (this.earlyData.length > 0) {
      const buffered = this.earlyData.join("");
      this.earlyData = [];
      listener(buffered);
    }
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  /** 注册 WSL PTY 退出监听器。 */
  public readonly onExit: IEvent<{ exitCode: number; signal?: number }> = (listener) => {
    this.exitListeners.add(listener);
    if (this.pendingExit)
      listener(this.pendingExit);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  /** 向工具进程内的 WSL PTY 写入用户输入或终端回复。 */
  public write(data: string | Buffer): void {
    this.postCommand({
      type: "write",
      data: Buffer.isBuffer(data) ? data.toString("utf8") : data,
    });
  }

  /** 等待前端完成绑定后，在工具进程内写入自动启动命令。 */
  public writeWhenFrontendReady(data: string): void {
    this.postCommand({ type: "write-when-ready", data });
  }

  /** 通知工具进程前端已绑定，并同步当前终端主题色。 */
  public markFrontendReady(colors?: Partial<TerminalPaletteColors>): void {
    this.postCommand({ type: "frontend-ready", colors });
  }

  /** 调整工具进程内 WSL PTY 的字符尺寸。 */
  public resize(columns: number, rows: number): void {
    this.currentCols = columns;
    this.currentRows = rows;
    this.postCommand({ type: "resize", columns, rows });
  }

  /** 清理工具进程内 ConPTY 的内部屏幕缓存。 */
  public clear(): void {
    this.postCommand({ type: "clear" });
  }

  /** 关闭工具进程内的 WSL PTY。 */
  public kill(signal?: string): void {
    this.postCommand({ type: "kill", signal });
    this.scheduleHostTermination();
  }

  /** 暂停工具进程向主进程转发普通画面。 */
  public pause(): void {
    this.postCommand({ type: "pause" });
  }

  /** 恢复工具进程向主进程转发普通画面。 */
  public resume(): void {
    this.postCommand({ type: "resume" });
  }

  /** 处理工具进程发回的 PTY 事件。 */
  private handleHostEvent(raw: unknown): void {
    const event = raw as WslConptyHostEvent | null;
    if (!event || typeof event !== "object" || typeof event.type !== "string")
      return;
    switch (event.type) {
      case "ready":
        this.currentPid = event.pid;
        this.currentCols = event.cols;
        this.currentRows = event.rows;
        this.currentProcess = event.process;
        this.flowControl = event.handleFlowControl;
        this.backend = event.backend;
        this.fallbackReason = event.fallbackReason;
        this.initialized = true;
        this.resolveInitialization();
        break;
      case "data":
        this.emitData(event.data);
        break;
      case "exit":
        this.emitExit({ exitCode: event.exitCode, signal: event.signal });
        this.terminateHost();
        break;
      case "fallback":
        try { this.onFallback?.(event.reason); } catch {}
        break;
      case "diagnostic":
        try { this.onDiagnostic?.(event.message); } catch {}
        break;
      case "init-error":
        this.rejectInitialization(new Error(event.error));
        this.terminateHost();
        break;
    }
  }

  /** 处理工具进程意外退出，并保证上层能收到会话终止。 */
  private handleHostExit(code: number): void {
    this.markHostTerminated();
    if (!this.initialized) {
      this.rejectInitialization(new Error(`WSL PTY host exited with code ${code}`));
      return;
    }
    if (!this.exited)
      this.emitExit({ exitCode: code });
  }

  /** 分发工具进程输出；上层尚未订阅时暂存启动期输出。 */
  private emitData(data: string): void {
    if (!data)
      return;
    if (this.dataListeners.size === 0) {
      this.earlyData.push(data);
      return;
    }
    for (const listener of this.dataListeners)
      listener(data);
  }

  /** 向所有退出监听器分发一次终端退出事件。 */
  private emitExit(event: { exitCode: number; signal?: number }): void {
    if (this.exited)
      return;
    this.exited = true;
    this.pendingExit = event;
    for (const listener of this.exitListeners)
      listener(event);
  }

  /** 完成工具进程初始化等待。 */
  private resolveInitialization(): void {
    const resolve = this.initResolve;
    this.initResolve = null;
    this.initReject = null;
    resolve?.();
  }

  /** 以给定错误结束工具进程初始化等待。 */
  private rejectInitialization(error: Error): void {
    const reject = this.initReject;
    this.initResolve = null;
    this.initReject = null;
    reject?.(error);
  }

  /** PTY 未主动退出时，安排一次工具进程兜底回收。 */
  private scheduleHostTermination(): void {
    if (this.hostTerminated || this.hostKillTimer)
      return;
    this.hostKillTimer = setTimeout(() => {
      this.hostKillTimer = null;
      this.terminateHost();
    }, WSL_HOST_KILL_TIMEOUT_MS);
    try { this.hostKillTimer.unref(); } catch {}
  }

  /** 幂等结束工具进程，并清理兜底计时器。 */
  private terminateHost(): void {
    if (this.hostKillTimer) {
      clearTimeout(this.hostKillTimer);
      this.hostKillTimer = null;
    }
    if (this.hostTerminated)
      return;
    this.hostTerminated = true;
    try {
      this.host.kill();
    } catch (error) {
      try { this.onDiagnostic?.(`host-kill-error ${describeHostError(error)}`); } catch {}
    }
  }

  /** 记录工具进程已经自行退出，并清理无须再执行的回收计时器。 */
  private markHostTerminated(): void {
    this.hostTerminated = true;
    if (!this.hostKillTimer)
      return;
    clearTimeout(this.hostKillTimer);
    this.hostKillTimer = null;
  }

  /** 安全地向 WSL PTY 工具进程发送命令。 */
  private postCommand(command: WslConptyHostCommand): void {
    if (this.exited)
      return;
    try {
      this.host.postMessage(command);
    } catch (error) {
      try { this.onDiagnostic?.(`host-post-error ${describeHostError(error)}`); } catch {}
    }
  }
}

/** 创建并等待一个由独立工具进程持有的 WSL ConPTY。 */
export async function spawnIsolatedWslConpty(
  options: WslConptyOptions,
  forkHost: ForkWslConptyHost = forkDefaultHost,
): Promise<IsolatedWslConptyPty> {
  const host = forkHost(resolveHostModulePath());
  const terminal = new IsolatedWslConptyPty(host, options);
  await terminal.initialize(options);
  return terminal;
}
