// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as nodePty from "node-pty";
import type {
  IEvent,
  IPty,
  IWindowsPtyForkOptions,
} from "node-pty";

const FRONTEND_READY_FALLBACK_MS = 2_000;
const PAUSED_FRONTEND_OUTPUT_MAX_CHARS = 200_000;
const DEFAULT_TERMINAL_COLORS: TerminalPaletteColors = {
  foreground: "#CCCCCC",
  background: "#0C0C0C",
};

const OSC_COLOR_QUERIES = [
  { sequence: "\x1B]10;?\x1B\\", slot: 10 },
  { sequence: "\x1B]10;?\x07", slot: 10 },
  { sequence: "\x1B]11;?\x1B\\", slot: 11 },
  { sequence: "\x1B]11;?\x07", slot: 11 },
] as const;

type SpawnPty = typeof nodePty.spawn;

export type WslConptyBackend = "bundled" | "system";

export type TerminalPaletteColors = {
  foreground: string;
  background: string;
};

export type WslConptyOptions = {
  file: string;
  args: string[];
  ptyOptions: IWindowsPtyForkOptions;
  onFallback?: (reason: string) => void;
  onDiagnostic?: (message: string) => void;
  frontendReadyTimeoutMs?: number;
  spawn?: SpawnPty;
};

/** 把未知异常转换为可记录的简短原因。 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message)
    return error.message;
  return String(error || "unknown error");
}

/** 把前端主题色规范为可安全写入终端协议的六位十六进制颜色。 */
function normalizeHexColor(value: unknown, fallback: string): string {
  const color = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : fallback;
}

/** 规范前端传入的终端前景色与背景色，非法值回退到 Campbell 默认色。 */
function normalizeTerminalColors(colors?: Partial<TerminalPaletteColors>): TerminalPaletteColors {
  return {
    foreground: normalizeHexColor(colors?.foreground, DEFAULT_TERMINAL_COLORS.foreground),
    background: normalizeHexColor(colors?.background, DEFAULT_TERMINAL_COLORS.background),
  };
}

/** 把六位十六进制颜色转换为 xterm OSC 查询使用的 16 位 RGB 表示。 */
function formatOscRgb(color: string): string {
  const red = color.slice(1, 3).toLowerCase();
  const green = color.slice(3, 5).toLowerCase();
  const blue = color.slice(5, 7).toLowerCase();
  return `rgb:${red}${red}/${green}${green}/${blue}${blue}`;
}

/** 计算数据末尾可能属于 OSC 10/11 查询前缀的字符数。 */
function findPendingOscQueryPrefixLength(data: string): number {
  const maxLength = Math.min(
    data.length,
    Math.max(...OSC_COLOR_QUERIES.map(({ sequence }) => sequence.length)) - 1,
  );
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = data.slice(-length);
    if (OSC_COLOR_QUERIES.some(({ sequence }) => sequence.startsWith(suffix)))
      return length;
  }
  return 0;
}

/** 查找一段终端输出中的下一条完整 OSC 10/11 颜色查询。 */
function findNextOscColorQuery(
  data: string,
  offset: number,
): { index: number; sequence: string; slot: 10 | 11 } | null {
  let next: { index: number; sequence: string; slot: 10 | 11 } | null = null;
  for (const query of OSC_COLOR_QUERIES) {
    const index = data.indexOf(query.sequence, offset);
    if (index < 0 || (next && index >= next.index))
      continue;
    next = { index, sequence: query.sequence, slot: query.slot };
  }
  return next;
}

/**
 * 使用应用内置 ConPTY 启动 WSL，并在同步启动失败时退回系统 ConPTY。
 */
export class WslConptyPty implements IPty {
  private readonly inner: IPty;
  private readonly frontendReadyTimeoutMs: number;
  private readonly onDiagnostic?: (message: string) => void;
  private readonly dataListeners = new Set<(data: string) => unknown>();
  private frontendReady = false;
  private frontendOutputPaused = false;
  private frontendReadyTimer: NodeJS.Timeout | null = null;
  private pendingFrontendWrites: string[] = [];
  private pausedFrontendOutput: string[] = [];
  private pausedFrontendOutputChars = 0;
  private pendingOscQueryPrefix = "";
  private terminalColors = { ...DEFAULT_TERMINAL_COLORS };

  public readonly backend: WslConptyBackend;
  public readonly fallbackReason?: string;

  /** 创建带系统 ConPTY 回退和前端就绪门控的 WSL PTY。 */
  constructor(options: WslConptyOptions) {
    const spawn = options.spawn || nodePty.spawn;
    this.onDiagnostic = options.onDiagnostic;
    this.frontendReadyTimeoutMs = Math.max(
      1,
      Math.floor(options.frontendReadyTimeoutMs ?? FRONTEND_READY_FALLBACK_MS),
    );

    try {
      this.inner = spawn(options.file, options.args, {
        ...options.ptyOptions,
        useConpty: true,
        useConptyDll: true,
      });
      this.backend = "bundled";
    } catch (error) {
      const reason = describeError(error);
      try { options.onFallback?.(reason); } catch {}
      this.inner = spawn(options.file, options.args, {
        ...options.ptyOptions,
        useConpty: true,
        useConptyDll: false,
      });
      this.backend = "system";
      this.fallbackReason = reason;
    }

    this.inner.onData((data) => this.handleInnerData(data));
  }

  /** 返回底层 PTY 进程编号。 */
  public get pid(): number {
    return this.inner.pid;
  }

  /** 返回当前终端列数。 */
  public get cols(): number {
    return this.inner.cols;
  }

  /** 返回当前终端行数。 */
  public get rows(): number {
    return this.inner.rows;
  }

  /** 返回底层活动进程名称。 */
  public get process(): string {
    return this.inner.process;
  }

  /** 返回底层流控制开关。 */
  public get handleFlowControl(): boolean {
    return this.inner.handleFlowControl;
  }

  /** 同步设置底层流控制开关。 */
  public set handleFlowControl(value: boolean) {
    this.inner.handleFlowControl = value;
  }

  /** 注册经过终端颜色查询处理后的输出监听器。 */
  public readonly onData: IEvent<string> = (listener) => {
    this.dataListeners.add(listener);
    return {
      dispose: () => this.dataListeners.delete(listener),
    };
  };

  /** 注册终端退出监听器，并清理尚未执行的启动命令。 */
  public readonly onExit: IEvent<{ exitCode: number; signal?: number }> = (listener) => (
    this.inner.onExit((event) => {
      this.flushPendingOscQueryPrefix();
      this.frontendOutputPaused = false;
      this.flushPausedFrontendOutput();
      this.disposeFrontendReadyGate();
      listener(event);
    })
  );

  /** 向底层 PTY 写入用户输入或终端协议回复。 */
  public write(data: string | Buffer): void {
    this.inner.write(data);
  }

  /** 在前端完成双向绑定后写入自动启动命令。 */
  public writeWhenFrontendReady(data: string): void {
    if (this.frontendReady) {
      this.inner.write(data);
      return;
    }
    this.pendingFrontendWrites.push(data);
    if (this.frontendReadyTimer)
      return;
    this.frontendReadyTimer = setTimeout(
      () => this.releaseFrontendWrites(),
      this.frontendReadyTimeoutMs,
    );
    try { this.frontendReadyTimer.unref(); } catch {}
  }

  /** 标记 xterm.js 输入输出通道已经完成绑定，并同步当前终端主题色。 */
  public markFrontendReady(colors?: Partial<TerminalPaletteColors>): void {
    this.terminalColors = normalizeTerminalColors(colors);
    this.reportDiagnostic(
      `frontend-ready foreground=${this.terminalColors.foreground} background=${this.terminalColors.background}`,
    );
    this.releaseFrontendWrites();
  }

  /** 调整底层 PTY 的字符尺寸。 */
  public resize(columns: number, rows: number): void {
    this.inner.resize(columns, rows);
  }

  /** 清理底层 ConPTY 的内部屏幕缓存。 */
  public clear(): void {
    this.inner.clear();
  }

  /** 关闭底层 PTY 并丢弃尚未执行的启动命令。 */
  public kill(signal?: string): void {
    this.disposeFrontendReadyGate();
    this.pendingOscQueryPrefix = "";
    this.pausedFrontendOutput = [];
    this.pausedFrontendOutputChars = 0;
    this.dataListeners.clear();
    this.inner.kill(signal);
  }

  /** 暂停向前端转发普通画面，但保持读取底层 PTY 以便及时处理终端协议。 */
  public pause(): void {
    if (this.frontendOutputPaused)
      return;
    this.frontendOutputPaused = true;
    this.reportDiagnostic(`frontend-output-paused buffered=${this.pausedFrontendOutputChars}`);
  }

  /** 恢复向前端转发，并按原顺序释放暂停期间缓存的普通画面。 */
  public resume(): void {
    if (!this.frontendOutputPaused && this.pausedFrontendOutputChars <= 0)
      return;
    const bufferedChars = this.pausedFrontendOutputChars;
    this.frontendOutputPaused = false;
    this.flushPausedFrontendOutput();
    this.reportDiagnostic(`frontend-output-resumed flushed=${bufferedChars}`);
  }

  /** 过滤 WSL 输出中的 OSC 10/11 查询，并直接把当前主题色写回 PTY。 */
  private handleInnerData(data: string): void {
    if (!data)
      return;
    if (!this.frontendReady) {
      this.emitData(data);
      return;
    }

    const buffered = this.pendingOscQueryPrefix + data;
    this.pendingOscQueryPrefix = "";
    let forwarded = "";
    let offset = 0;
    const answeredSlots: Array<10 | 11> = [];
    let query = findNextOscColorQuery(buffered, offset);
    while (query) {
      forwarded += buffered.slice(offset, query.index);
      this.respondToOscColorQuery(query.slot);
      answeredSlots.push(query.slot);
      offset = query.index + query.sequence.length;
      query = findNextOscColorQuery(buffered, offset);
    }

    const tail = buffered.slice(offset);
    const pendingLength = findPendingOscQueryPrefixLength(tail);
    if (pendingLength > 0) {
      forwarded += tail.slice(0, -pendingLength);
      this.pendingOscQueryPrefix = tail.slice(-pendingLength);
    } else {
      forwarded += tail;
    }
    for (const slot of answeredSlots) {
      this.reportOscQueryDiagnostic(slot, this.frontendOutputPaused);
    }
    this.emitData(forwarded);
  }

  /** 向 WSL PTY 写回指定颜色槽位的 OSC RGB 响应。 */
  private respondToOscColorQuery(slot: 10 | 11): void {
    const color = slot === 10 ? this.terminalColors.foreground : this.terminalColors.background;
    this.inner.write(`\x1B]${slot};${formatOscRgb(color)}\x1B\\`);
  }

  /** 把普通终端输出分发给上层；前端暂停期间只做有界缓存。 */
  private emitData(data: string): void {
    if (!data)
      return;
    if (this.frontendOutputPaused) {
      this.pausedFrontendOutput.push(data);
      this.pausedFrontendOutputChars += data.length;
      if (this.pausedFrontendOutputChars < PAUSED_FRONTEND_OUTPUT_MAX_CHARS)
        return;
      this.reportDiagnostic(
        `frontend-output-buffer-limit chars=${this.pausedFrontendOutputChars}`,
      );
      this.flushPausedFrontendOutput();
      return;
    }
    this.dispatchData(data);
  }

  /** 不经过暂停判断，直接把终端画面分发给所有上层监听器。 */
  private dispatchData(data: string): void {
    if (!data)
      return;
    for (const listener of this.dataListeners)
      listener(data);
  }

  /** 合并并释放暂停期间缓存的普通终端画面。 */
  private flushPausedFrontendOutput(): void {
    if (this.pausedFrontendOutputChars <= 0)
      return;
    const buffered = this.pausedFrontendOutput.join("");
    this.pausedFrontendOutput = [];
    this.pausedFrontendOutputChars = 0;
    this.dispatchData(buffered);
  }

  /** 在进程退出时原样释放尚未能判定的 OSC 查询前缀。 */
  private flushPendingOscQueryPrefix(): void {
    const pending = this.pendingOscQueryPrefix;
    this.pendingOscQueryPrefix = "";
    this.emitData(pending);
  }

  /** 向调用方报告低频 WSL 终端协议诊断信息。 */
  private reportDiagnostic(message: string): void {
    try { this.onDiagnostic?.(message); } catch {}
  }

  /** 延后报告颜色查询，确保诊断 IPC 不进入 Codex 的 100ms 回复关键路径。 */
  private reportOscQueryDiagnostic(slot: 10 | 11, frontendPaused: boolean): void {
    const timer = setTimeout(() => {
      this.reportDiagnostic(
        `osc-query slot=${slot} frontendPaused=${frontendPaused ? "1" : "0"}`,
      );
    }, 150);
    try { timer.unref(); } catch {}
  }

  /** 释放前端门控并按顺序写入等待中的启动命令。 */
  private releaseFrontendWrites(): void {
    if (this.frontendReady)
      return;
    this.frontendReady = true;
    this.clearFrontendReadyTimer();
    const writes = this.pendingFrontendWrites.splice(0);
    this.reportDiagnostic(`startup-writes-released count=${writes.length}`);
    for (const data of writes)
      this.inner.write(data);
  }

  /** 丢弃等待中的启动命令并清理定时器。 */
  private disposeFrontendReadyGate(): void {
    this.clearFrontendReadyTimer();
    this.pendingFrontendWrites = [];
  }

  /** 清理前端就绪兜底定时器。 */
  private clearFrontendReadyTimer(): void {
    if (!this.frontendReadyTimer)
      return;
    clearTimeout(this.frontendReadyTimer);
    this.frontendReadyTimer = null;
  }
}

/** 创建 WSL ConPTY 会话。 */
export function spawnWslConpty(options: WslConptyOptions): WslConptyPty {
  return new WslConptyPty(options);
}
