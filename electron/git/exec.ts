// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  /** 附加到 Git 子进程的环境变量（会覆盖同名默认值）。 */
  envPatch?: NodeJS.ProcessEnv;
  /** 可选标准输入内容；用于 `update-index --index-info` 这类需要通过 stdin 传参的 Git 命令。 */
  stdin?: string | Buffer;
};

/**
 * 构建 Git 子进程环境变量，统一编码与交互行为。
 * - 强制 UTF-8 语言环境，减少中文输出乱码概率；
 * - 禁用 pager，避免非交互场景阻塞；
 * - 禁止终端提示，改为直接失败并返回错误，防止 UI 命令悬挂。
 */
function buildGitProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!String(env.LC_ALL || "").trim()) env.LC_ALL = "C.UTF-8";
  if (!String(env.LANG || "").trim()) env.LANG = "C.UTF-8";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * 在标准 Git 环境基础上叠加调用方传入的环境变量。
 */
function mergeGitProcessEnv(envPatch?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = buildGitProcessEnv();
  if (!envPatch) return base;
  return {
    ...base,
    ...envPatch,
  };
}

/**
 * 执行需要完整采集 stdout/stderr 的 Git 命令。
 * - 内部直接复用 `spawnGitAsync`，与 IDEA `GitLineHandler` 一样走流式读写，彻底移除 `execFile` 的 `maxBuffer` 上限；
 * - 仍保持“完整收集输出后返回”的调用语义，兼容现有短命令调用点。
 */
export async function execGitAsync(opts: GitExecOptions): Promise<GitExecResult> {
  return await spawnGitAsync({
    gitPath: opts?.gitPath,
    cwd: opts?.cwd,
    argv: opts?.argv,
    timeoutMs: opts?.timeoutMs,
    envPatch: opts?.envPatch,
    stdin: opts?.stdin,
  });
}

export type GitSpawnOptions = GitExecOptions & {
  /** stdout 数据到达时回调（用于流式日志展示）。 */
  onStdout?: (chunk: string) => void;
  /** stderr 数据到达时回调（用于流式日志展示）。 */
  onStderr?: (chunk: string) => void;
  /** 可选取消信号；触发后会尽快终止子进程并返回 aborted。 */
  signal?: AbortSignal;
};

export type GitSpawnStdoutToFileOptions = GitExecOptions & {
  /** stdout 目标文件路径，命令输出会直接写入该文件。 */
  outFile: string;
  /** stderr 数据到达时回调（用于流式日志展示）。 */
  onStderr?: (chunk: string) => void;
  /** 可选取消信号；触发后会尽快终止子进程并返回 aborted。 */
  signal?: AbortSignal;
};

/**
 * 获取 Windows 下 `taskkill` 的可靠路径（避免某些运行环境 PATH 不包含 System32）。
 *
 * 设计要点：
 * - Electron 打包/便携环境下 PATH 可能被裁剪，直接 spawn("taskkill") 可能失败
 * - 优先使用绝对路径，其次回退到命令名让系统自行解析
 */
function resolveWindowsTaskkillPathBestEffort(): string {
  const winRoot = String(process.env.SystemRoot || process.env.WINDIR || "").trim();
  const candidates: string[] = [];
  if (winRoot) {
    // Sysnative：用于 32 位进程访问 64 位 System32（尽量兼容，存在就用）
    candidates.push(path.join(winRoot, "Sysnative", "taskkill.exe"));
    candidates.push(path.join(winRoot, "System32", "taskkill.exe"));
  }
  candidates.push("taskkill");

  for (const candidate of candidates) {
    if (candidate === "taskkill") return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return "taskkill";
}

/**
 * 尽力终止 Git 子进程整棵进程树，避免超时或取消后残留后台进程。
 */
function killGitChildProcessTreeBestEffort(child: ReturnType<typeof spawn> | null): void {
  const pid = typeof child?.pid === "number" ? child.pid : 0;
  if (!pid) return;

  if (process.platform === "win32") {
    try {
      const taskkill = resolveWindowsTaskkillPathBestEffort();
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {
        try { child?.kill(); } catch {}
        try { child?.kill("SIGKILL"); } catch {}
      });
      killer.unref?.();
    } catch {
      try { child?.kill(); } catch {}
      try { child?.kill("SIGKILL"); } catch {}
    }
    return;
  }

  try { child?.kill(); } catch {}
  try { child?.kill("SIGKILL"); } catch {}
}

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
    let aborted = false;
    let timeoutHandle: any = null;
    const signal = opts?.signal;
    let child: ReturnType<typeof spawn> | null = null;

    const finalize = (res: GitExecResult) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) {
        try { clearTimeout(timeoutHandle); } catch {}
        timeoutHandle = null;
      }
      if (signal) {
        try { signal.removeEventListener("abort", onAbort); } catch {}
      }
      resolve(res);
    };

    const onAbort = () => {
      aborted = true;
      killGitChildProcessTreeBestEffort(child);
    };

    try {
      if (signal?.aborted) {
        finalize({ ok: false, stdout: "", stderr: "", exitCode: -1, error: "aborted" });
        return;
      }

      try {
        child = spawn(gitPath, argv, {
          cwd,
          env: mergeGitProcessEnv(opts?.envPatch),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
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
        return;
      }

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killGitChildProcessTreeBestEffort(child);
      }, timeoutMs);

      if (signal) {
        try { signal.addEventListener("abort", onAbort, { once: true }); } catch {}
        // 覆盖“在 spawn 与监听绑定之间触发 abort”的竞态，尽量做到及时终止
        if (signal.aborted && !aborted) onAbort();
      }

      /**
       * 在命令启动后尽快写入 stdin，并始终显式关闭输入流，避免 `git update-index --index-info` 等命令等待 EOF。
       */
      const closeStdin = (): void => {
        try { child?.stdin?.end(); } catch {}
      };
      try {
        if (child.stdin) {
          child.stdin.on("error", () => {});
          if (typeof opts?.stdin === "string" || Buffer.isBuffer(opts?.stdin)) child.stdin.write(opts.stdin);
          closeStdin();
        }
      } catch {
        closeStdin();
      }

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
        if (aborted) {
          finalize({ ok: false, stdout, stderr, exitCode: -1, error: "aborted" });
          return;
        }
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
        if (aborted) {
          finalize({ ok: false, stdout, stderr, exitCode, error: "aborted" });
          return;
        }
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
        // 非 0 exitCode：尽量优先把 stderr/stdout 提升为错误摘要，避免 UI 只看到 “exit <code>” 无法定位原因
        const errText = String(stderr || "").trim();
        const outText = String(stdout || "").trim();
        const summaryRaw = errText || outText;
        const summaryMaxChars = 4096;
        const summary =
          summaryRaw.length > summaryMaxChars
            ? `${summaryRaw.slice(0, summaryMaxChars)}…`
            : summaryRaw;
        const msg = summary ? `${summary}\n(exit ${exitCode})` : `exit ${exitCode}`;
        finalize({ ok: false, stdout, stderr, exitCode, error: msg });
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
 * 以流式方式执行 Git 命令，并把 stdout 直接写入文件，避免大补丁占满内存。
 */
export async function spawnGitStdoutToFileAsync(opts: GitSpawnStdoutToFileOptions): Promise<GitExecResult> {
  const gitPath = String(opts?.gitPath || "").trim() || "git";
  const argv = Array.isArray(opts?.argv) ? opts.argv.map((x) => String(x)) : [];
  const cwd = typeof opts?.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd : undefined;
  const outFile = String(opts?.outFile || "").trim();
  const timeoutMs = Math.max(200, Math.min(30 * 60_000, Number(opts?.timeoutMs ?? 8000)));
  const signal = opts?.signal;
  if (!outFile) {
    return { ok: false, stdout: "", stderr: "", exitCode: -1, error: "missing outFile" };
  }

  return await new Promise<GitExecResult>((resolve) => {
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let aborted = false;
    let timeoutHandle: any = null;
    let child: ReturnType<typeof spawn> | null = null;
    let writer: fs.WriteStream | null = null;

    const finalize = (res: GitExecResult) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) {
        try { clearTimeout(timeoutHandle); } catch {}
        timeoutHandle = null;
      }
      if (signal) {
        try { signal.removeEventListener("abort", onAbort); } catch {}
      }
      resolve(res);
    };

    const onAbort = () => {
      aborted = true;
      killGitChildProcessTreeBestEffort(child);
    };

    const closeWriterAndFinalize = (res: GitExecResult) => {
      const done = () => finalize(res);
      if (!writer) {
        done();
        return;
      }
      try {
        writer.end();
        writer.once("finish", done);
        writer.once("error", done);
      } catch {
        done();
      }
    };

    try {
      if (signal?.aborted) {
        finalize({ ok: false, stdout: "", stderr: "", exitCode: -1, error: "aborted" });
        return;
      }

      writer = fs.createWriteStream(outFile, { flags: "w" });
      writer.on("error", (err: any) => {
        killGitChildProcessTreeBestEffort(child);
        finalize({
          ok: false,
          stdout: "",
          stderr,
          exitCode: -1,
          error: String(err?.message || err),
          errorCode: typeof err?.code === "string" ? String(err.code) : undefined,
        });
      });

      child = spawn(gitPath, argv, {
        cwd,
        env: mergeGitProcessEnv(opts?.envPatch),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killGitChildProcessTreeBestEffort(child);
      }, timeoutMs);

      if (signal) {
        try { signal.addEventListener("abort", onAbort, { once: true }); } catch {}
        if (signal.aborted && !aborted) onAbort();
      }

      child.stdout?.on("data", (buf: Buffer) => {
        try {
          const ok = writer?.write(buf) ?? false;
          if (!ok) {
            try { child?.stdout?.pause(); } catch {}
            writer?.once("drain", () => {
              try { child?.stdout?.resume(); } catch {}
            });
          }
        } catch {}
      });

      child.stderr?.on("data", (buf: Buffer) => {
        const chunk = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
        stderr += chunk;
        try { opts?.onStderr?.(chunk); } catch {}
      });

      child.on("error", (err: any) => {
        if (aborted) {
          closeWriterAndFinalize({ ok: false, stdout: "", stderr, exitCode: -1, error: "aborted" });
          return;
        }
        closeWriterAndFinalize({
          ok: false,
          stdout: "",
          stderr,
          exitCode: -1,
          error: String(err?.message || err),
          errorCode: typeof err?.code === "string" ? String(err.code) : undefined,
        });
      });

      child.on("close", (code: number | null) => {
        const exitCode = typeof code === "number" ? code : -1;
        if (aborted) {
          closeWriterAndFinalize({ ok: false, stdout: "", stderr, exitCode, error: "aborted" });
          return;
        }
        if (timedOut) {
          closeWriterAndFinalize({ ok: false, stdout: "", stderr, exitCode, error: `timeout after ${timeoutMs}ms` });
          return;
        }
        if (exitCode === 0) {
          closeWriterAndFinalize({ ok: true, stdout: "", stderr, exitCode: 0 });
          return;
        }
        const errText = String(stderr || "").trim();
        const summaryMaxChars = 4096;
        const summary = errText.length > summaryMaxChars
          ? `${errText.slice(0, summaryMaxChars)}…`
          : errText;
        const message = summary ? `${summary}\n(exit ${exitCode})` : `exit ${exitCode}`;
        closeWriterAndFinalize({ ok: false, stdout: "", stderr, exitCode, error: message });
      });
    } catch (e: any) {
      closeWriterAndFinalize({
        ok: false,
        stdout: "",
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

