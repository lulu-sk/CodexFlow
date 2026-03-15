// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/** 简单本地性能日志工具：将时间点/耗时写入应用目录 */
export class PerfLogger {
  private fileName: string;
  private enabled = false;

  /**
   * 创建性能日志器（默认写入 `${userData}/perf.log`）。
   * 说明：为支持“按 profile 隔离 userData”，日志路径在写入时动态解析。
   */
  constructor(fileName = "perf.log") {
    this.fileName = fileName;
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
  log(msg: string) {
    if (!this.enabled) return;
    this.writeLine(msg);
  }

  /**
   * 写入一条强制日志（不受 `global.diagLog` 影响）。
   * 说明：仅用于白屏/强制刷新等需要默认保留排障线索的关键诊断。
   */
  logAlways(msg: string): void {
    this.writeLine(msg);
  }

  /**
   * 实际执行日志落盘。
   */
  private writeLine(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    try { fs.appendFileSync(this.resolveLogPath(), line + "\n", "utf8"); } catch {}
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
