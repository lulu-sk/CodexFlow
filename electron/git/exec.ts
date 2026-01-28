// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { execFile, spawn } from "node:child_process";

export type GitExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  /** spawn/exec 失败时的错误码（例如 ENOENT/EACCES），用于区分“git 不可用”等场景。 */
  errorCode?: string;
};

export type GitExecOptions = {
  /** Git 可执行文件路径（为空则回退到 "git"）。 */
  gitPath?: string;
  /** 执行工作目录（可选）。 */
  cwd?: string;
  /** 传给 git 的参数列表（不含 git 本身）。 */
  argv: string[];
  /** 超时时间（毫秒），必须显式存在，避免悬挂。 */
  timeoutMs?: number;
};

/**
 * 以带超时的方式执行 git 命令，并返回 stdout/stderr/exitCode（失败也尽量返回输出便于诊断）。
 */
export async function execGitAsync(opts: GitExecOptions): Promise<GitExecResult> {
  const gitPath = String(opts?.gitPath || "").trim() || "git";
  const argv = Array.isArray(opts?.argv) ? opts.argv.map((x) => String(x)) : [];
  const cwd = typeof opts?.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd : undefined;
  const timeoutMs = Math.max(200, Math.min(30_000, Number(opts?.timeoutMs ?? 8000)));
  return await new Promise<GitExecResult>((resolve) => {
    try {
      execFile(
        gitPath,
        argv,
        {
          cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        },
        (err: any, stdout: any, stderr: any) => {
          const out = String(stdout || "");
          const errOut = String(stderr || "");
          const exitCode = typeof err?.code === "number" ? err.code : -1;
          const errorCode = typeof err?.code === "string" ? String(err.code) : undefined;
          if (!err) {
            resolve({ ok: true, stdout: out, stderr: errOut, exitCode: 0 });
            return;
          }
          const msg = String(err?.message || err);
          resolve({ ok: false, stdout: out, stderr: errOut, exitCode, error: msg, errorCode });
        }
      );
    } catch (e: any) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: -1,
        error: String(e?.message || e),
        errorCode: typeof e?.code === "string" ? String(e.code) : undefined,
      });
    }
  });
}

export type GitSpawnOptions = GitExecOptions & {
  /** 中文说明：stdout 数据到达时回调（用于流式日志展示）。 */
  onStdout?: (chunk: string) => void;
  /** 中文说明：stderr 数据到达时回调（用于流式日志展示）。 */
  onStderr?: (chunk: string) => void;
};

/**
 * 以 spawn 方式执行 git 命令，支持流式读取 stdout/stderr，并在超时后强制终止。
 *
 * 说明：
 * - execFile 有 maxBuffer 限制；大仓库/进度输出场景下更容易截断。这里使用 spawn 规避。
 * - 仍会累计 stdout/stderr 以便在调用方需要时返回完整信息。
 */
export async function spawnGitAsync(opts: GitSpawnOptions): Promise<GitExecResult> {
  const gitPath = String(opts?.gitPath || "").trim() || "git";
  const argv = Array.isArray(opts?.argv) ? opts.argv.map((x) => String(x)) : [];
  const cwd = typeof opts?.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd : undefined;
  const timeoutMs = Math.max(200, Math.min(30 * 60_000, Number(opts?.timeoutMs ?? 8000)));

  return await new Promise<GitExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timeoutHandle: any = null;

    const finalize = (res: GitExecResult) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) {
        try { clearTimeout(timeoutHandle); } catch {}
        timeoutHandle = null;
      }
      resolve(res);
    };

    try {
      const child = spawn(gitPath, argv, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
        // 兜底：若未退出，延迟再强杀一次
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 800);
      }, timeoutMs);

      child.stdout?.on("data", (buf: Buffer) => {
        const chunk = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
        stdout += chunk;
        try { opts?.onStdout?.(chunk); } catch {}
      });
      child.stderr?.on("data", (buf: Buffer) => {
        const chunk = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
        stderr += chunk;
        try { opts?.onStderr?.(chunk); } catch {}
      });

      child.on("error", (err: any) => {
        const msg = String(err?.message || err);
        finalize({
          ok: false,
          stdout,
          stderr,
          exitCode: -1,
          error: msg,
          errorCode: typeof err?.code === "string" ? String(err.code) : undefined,
        });
      });

      child.on("close", (code: number | null) => {
        const exitCode = typeof code === "number" ? code : -1;
        if (timedOut) {
          finalize({
            ok: false,
            stdout,
            stderr,
            exitCode,
            error: `timeout after ${timeoutMs}ms`,
          });
          return;
        }
        if (exitCode === 0) {
          finalize({ ok: true, stdout, stderr, exitCode: 0 });
          return;
        }
        // 非 0 exitCode：尽量把 stderr/stdout 返回给上层拼装诊断信息
        finalize({ ok: false, stdout, stderr, exitCode, error: `exit ${exitCode}` });
      });
    } catch (e: any) {
      finalize({
        ok: false,
        stdout,
        stderr,
        exitCode: -1,
        error: String(e?.message || e),
        errorCode: typeof e?.code === "string" ? String(e.code) : undefined,
      });
    }
  });
}

/**
 * 判断一次 git 执行失败是否由“git 可执行文件不可用”导致（未安装 / 路径错误 / 无法启动）。
 */
export function isGitExecutableUnavailable(res: GitExecResult): boolean {
  if (res.ok) return false;
  const code = String(res.errorCode || "").trim();
  if (code === "ENOENT" || code === "EACCES") return true;
  const msg = `${String(res.error || "")}\n${String(res.stderr || "")}`;
  return /ENOENT|not found|not recognized as an internal or external command|系统找不到指定的文件|cannot find the file|CreateProcess/i.test(msg);
}

