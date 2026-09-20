// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { EventEmitter, once } from "node:events";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execGitAsync, spawnGitAsync, spawnGitStdoutToFileAsync } from "./exec";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

/** 用真实字节流模拟 Git 子进程，强制复现任意字符跨数据块的情况。 */
function createGitProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

/** 按单字节交错写入两个输出流，并等待解码器处理完尾部后通知进程退出。 */
async function completeGitProcess(
  child: ReturnType<typeof createGitProcess>,
  stdout: Buffer,
  stderr: Buffer,
  exitCode = 0,
): Promise<void> {
  const ended = Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
  for (let index = 0; index < Math.max(stdout.length, stderr.length); index += 1) {
    if (index < stdout.length) child.stdout.write(stdout.subarray(index, index + 1));
    if (index < stderr.length) child.stderr.write(stderr.subarray(index, index + 1));
  }
  child.stdout.end();
  child.stderr.end();
  await ended;
  child.emit("close", exitCode);
}

afterEach(() => vi.clearAllMocks());

describe("Git 输出流编码", () => {
  it("完整输出应保留跨块中文、四字节字符、BOM 和换行", async () => {
    const child = createGitProcess();
    const stdout = "\uFEFFdiff --git a/示例.ts b/示例.ts\r\n-旧值🙂\n+新值🚀\n";
    const stderr = "提示：读取完成✓\n";
    const pending = execGitAsync({ argv: ["diff"], timeoutMs: 2000 });
    await completeGitProcess(child, Buffer.from(stdout), Buffer.from(stderr));
    expect(await pending).toMatchObject({ ok: true, stdout, stderr, exitCode: 0 });
  });

  it("流式回调与完整输出应一致，两个流的解码状态互不干扰", async () => {
    const child = createGitProcess();
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const stdout = "你好🌏\n";
    const stderr = "警告：错误🚧\n";
    const pending = spawnGitAsync({ argv: ["show"], timeoutMs: 2000, onStdout, onStderr });
    await completeGitProcess(child, Buffer.from(stdout), Buffer.from(stderr), 1);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, stdout, stderr, exitCode: 1 });
    expect(result.error).toContain(stderr.trim());
    expect(onStdout.mock.calls.map(([chunk]) => chunk).join("")).toBe(stdout);
    expect(onStderr.mock.calls.map(([chunk]) => chunk).join("")).toBe(stderr);
  });

  it("流结束时应处理残缺的最后一个字符，不能漏掉尾部输出", async () => {
    const child = createGitProcess();
    const pending = spawnGitAsync({ argv: ["show"], timeoutMs: 2000 });
    await completeGitProcess(child, Buffer.from([0x61, 0xe4, 0xb8]), Buffer.alloc(0));
    expect(await pending).toMatchObject({ stdout: "a\uFFFD" });
  });

  it("写入文件时应保留原始字节，仅解码用于显示的错误输出", async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "git-stream-encoding-"));
    try {
      const child = createGitProcess();
      const outFile = path.join(directory, "blob.bin");
      const bytes = Buffer.from([0, 0xff, 0xe4, 0xb8, 0xad, 0x0d, 0x0a]);
      const stderr = "正在导出中文🙂\n";
      const onStderr = vi.fn();
      const pending = spawnGitStdoutToFileAsync({ argv: ["show"], outFile, timeoutMs: 2000, onStderr });
      await completeGitProcess(child, bytes, Buffer.from(stderr));
      expect(await pending).toMatchObject({ ok: true, stdout: "", stderr });
      expect(await fsp.readFile(outFile)).toEqual(bytes);
      expect(onStderr.mock.calls.map(([chunk]) => chunk).join("")).toBe(stderr);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
