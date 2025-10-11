// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/** 简单本地性能日志工具：将时间点/耗时写入应用目录 */
export class PerfLogger {
  private logPath: string;
  constructor(fileName = "perf.log") {
    try {
      const dir = app.getPath("userData");
      this.logPath = path.join(dir, fileName);
    } catch {
      this.logPath = path.join(process.cwd(), fileName);
    }
  }
  log(msg: string) {
    const line = `${new Date().toISOString()} ${msg}`;
    try { fs.appendFileSync(this.logPath, line + "\n", "utf8"); } catch {}
  }
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

