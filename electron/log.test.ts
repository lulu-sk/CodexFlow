// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => testState.userDataDir,
  },
}));

import { PerfLogger } from "./log";

describe("PerfLogger", () => {
  beforeAll(() => {
    testState.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-perf-log-"));
  });

  afterAll(() => {
    fs.rmSync(testState.userDataDir, { recursive: true, force: true });
  });

  /** 创建使用独立文件名的测试日志器。 */
  function createLogger(fileName: string, options?: ConstructorParameters<typeof PerfLogger>[1]): PerfLogger {
    return new PerfLogger(fileName, { flushDelayMs: 60_000, ...options });
  }

  it("关闭普通诊断时不创建日志文件", async () => {
    const logger = createLogger("disabled.log");
    logger.log("ignored");
    await logger.flush();
    expect(fs.existsSync(path.join(testState.userDataDir, "disabled.log"))).toBe(false);
  });

  it("关键诊断不受普通开关影响并立即落盘", () => {
    const logger = createLogger("critical.log");
    const logPath = path.join(testState.userDataDir, "critical.log");
    logger.logAlways("critical");
    expect(fs.readFileSync(logPath, "utf8")).toContain("critical");
  });

  it("将多条普通诊断合并后异步落盘", async () => {
    const logger = createLogger("batched.log");
    const logPath = path.join(testState.userDataDir, "batched.log");
    logger.setEnabled(true);
    logger.log("first");
    logger.log("second");

    expect(fs.existsSync(logPath)).toBe(false);
    await logger.flush();

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("first");
    expect(content).toContain("second");
  });

  it("超过文件上限时轮换旧日志", async () => {
    const logger = createLogger("rotate.log", { maxFileBytes: 1024 });
    const logPath = path.join(testState.userDataDir, "rotate.log");
    fs.writeFileSync(logPath, "x".repeat(1024), "utf8");
    logger.setEnabled(true);
    logger.log("new-batch");
    await logger.flush();

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toHaveLength(1024);
    expect(fs.readFileSync(logPath, "utf8")).toContain("new-batch");
  });

  it("队列超过上限时保留最新诊断并记录丢弃数量", async () => {
    const logger = createLogger("bounded.log", { maxPendingBytes: 1024 });
    const logPath = path.join(testState.userDataDir, "bounded.log");
    logger.setEnabled(true);
    logger.log(`old-${"x".repeat(700)}`);
    logger.log(`middle-${"y".repeat(700)}`);
    logger.log("latest");
    await logger.flush();

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("reason=pending-overflow");
    expect(content).not.toContain("old-");
    expect(content).toContain("latest");
  });
});
