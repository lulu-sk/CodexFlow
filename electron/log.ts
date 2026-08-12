// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type PerfLoggerOptions = {
  flushDelayMs?: number;
  maxFileBytes?: number;
  maxPendingBytes?: number;
};

const DEFAULT_FLUSH_DELAY_MS = 100;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
const MAX_LOG_MESSAGE_BYTES = 64 * 1024;

/** 简单本地性能日志工具：将时间点/耗时写入应用目录 */
export class PerfLogger {
  private readonly fileName: string;
  private readonly flushDelayMs: number;
  private readonly maxFileBytes: number;
  private readonly maxPendingBytes: number;
  private enabled = false;
  private pendingLines: string[] = [];
  private pendingBytes = 0;
  private droppedLineCount = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;

  /**
   * 创建性能日志器（默认写入 `${userData}/perf.log`）。
   * 说明：为支持“按 profile 隔离 userData”，日志路径在写入时动态解析。
   */
  constructor(fileName = "perf.log", options?: PerfLoggerOptions) {
    this.fileName = fileName;
    this.flushDelayMs = Math.max(0, Math.floor(options?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS));
    this.maxFileBytes = Math.max(1024, Math.floor(options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
    this.maxPendingBytes = Math.max(1024, Math.floor(options?.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES));
  }

  /**
   * 设置 perf.log 是否启用写入。
   * 说明：统一由 `debug.config.jsonc` 的 `global.diagLog` 控制。
   */
  setEnabled(enabled: boolean): void {
    this.enabled = !!enabled;
  }

  /**
   * 解析当前日志文件路径：优先写入 userData，失败回退到进程工作目录。
   */
  private resolveLogPath(): string {
    try {
      const dir = app.getPath("userData");
      return path.join(dir, this.fileName);
    } catch {
      return path.join(process.cwd(), this.fileName);
    }
  }

  /**
   * 写入一条日志（附带 ISO 时间戳）。
   */
  log(msg: string): void {
    if (!this.enabled) return;
    this.enqueueLine(msg);
  }

  /**
   * 写入一条强制日志（不受 `global.diagLog` 影响）。
   * 说明：仅用于白屏/强制刷新等需要默认保留排障线索的关键诊断。
   */
  logAlways(msg: string): void {
    const line = `${new Date().toISOString()} ${this.clampMessage(String(msg ?? ""))}\n`;
    try {
      const logPath = this.resolveLogPath();
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line, "utf8");
    } catch {}
  }

  /**
   * 等待当前队列全部异步落盘，主要供测试与受控退出流程使用。
   */
  async flush(): Promise<void> {
    await this.flushPendingLines();
    if (this.pendingLines.length > 0)
      await this.flush();
  }

  /**
   * 将日志加入有界内存队列，避免高频终端诊断逐条阻塞 Electron 主线程。
   */
  private enqueueLine(msg: string): void {
    const text = this.clampMessage(String(msg ?? ""));
    const line = `${new Date().toISOString()} ${text}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    this.pendingLines.push(line);
    this.pendingBytes += bytes;
    this.trimPendingQueue();
    this.scheduleFlush();
  }

  /**
   * 限制单条日志尺寸，避免异常输出独占整个待写队列。
   */
  private clampMessage(msg: string): string {
    if (Buffer.byteLength(msg, "utf8") <= MAX_LOG_MESSAGE_BYTES)
      return msg;
    let low = 0;
    let high = msg.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(msg.slice(0, mid), "utf8") <= MAX_LOG_MESSAGE_BYTES)
        low = mid;
      else
        high = mid - 1;
    }
    return `${msg.slice(0, low)}…[truncated]`;
  }

  /**
   * 裁剪积压队列并统计丢弃行数，防止磁盘异常时日志无限占用内存。
   */
  private trimPendingQueue(): void {
    while (this.pendingBytes > this.maxPendingBytes && this.pendingLines.length > 1) {
      const removed = this.pendingLines.shift();
      if (!removed)
        break;
      this.pendingBytes -= Buffer.byteLength(removed, "utf8");
      this.droppedLineCount += 1;
    }
  }

  /**
   * 安排一次批量写入；更紧急的请求会提前现有计时器。
   */
  private scheduleFlush(): void {
    if (this.flushPromise)
      return;
    if (this.flushTimer)
      return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingLines();
    }, this.flushDelayMs);
    try { this.flushTimer.unref?.(); } catch {}
  }

  /**
   * 取出当前队列并串行异步写入，确保多个批次不会互相覆盖或乱序。
   */
  private async flushPendingLines(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }
    if (this.pendingLines.length === 0)
      return;

    const dropped = this.droppedLineCount;
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.pendingBytes = 0;
    this.droppedLineCount = 0;
    if (dropped > 0)
      lines.unshift(`${new Date().toISOString()} [perf.log] dropped=${dropped} reason=pending-overflow\n`);

    const logPath = this.resolveLogPath();
    const content = lines.join("");
    const incomingBytes = Buffer.byteLength(content, "utf8");
    const write = this.appendBatch(logPath, content, incomingBytes)
      .catch(() => {})
      .finally(() => {
        this.flushPromise = null;
        if (this.pendingLines.length > 0)
          this.scheduleFlush();
      });
    this.flushPromise = write;
    await write;
  }

  /**
   * 创建目录、执行日志轮换并异步追加一个批次。
   */
  private async appendBatch(logPath: string, content: string, incomingBytes: number): Promise<void> {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await this.rotateIfNeeded(logPath, incomingBytes);
    await fs.promises.appendFile(logPath, content, "utf8");
  }

  /**
   * 当日志超过上限时保留一份旧文件，防止 perf.log 长期无限增长。
   */
  private async rotateIfNeeded(logPath: string, incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try { currentBytes = (await fs.promises.stat(logPath)).size; } catch {}
    if (currentBytes + incomingBytes <= this.maxFileBytes)
      return;
    const backupPath = `${logPath}.1`;
    try { await fs.promises.rm(backupPath, { force: true }); } catch {}
    try { await fs.promises.rename(logPath, backupPath); } catch {}
  }

  /**
   * 记录一段异步/同步任务的开始与耗时（自动写入 done/fail）。
   */
  time<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const start = Date.now();
    try { this.log(`[start] ${label}`); } catch {}
    const done = (ok = true) => {
      const dur = Date.now() - start;
      this.log(`[${ok ? "done" : "fail"}] ${label} ${dur}ms`);
    };
    try {
      const ret = fn();
      if (ret && typeof (ret as any).then === "function") {
        return (ret as Promise<T>).then((v) => { done(true); return v; }).catch((e) => { done(false); throw e; });
      }
      done(true);
      return Promise.resolve(ret as T);
    } catch (e) {
      done(false);
      return Promise.reject(e);
    }
  }
}

export const perfLogger = new PerfLogger();
