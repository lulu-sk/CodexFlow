// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import { execGitAsync, isGitExecutableUnavailable } from "./exec";
import { toFsPathAbs } from "./pathKey";

export type InitGitRepositoryResult = {
  ok: boolean;
  dir: string;
  repoRoot?: string;
  branch?: string;
  /** 是否属于“已是 Git 仓库”场景（作为幂等成功返回）。 */
  alreadyRepo?: boolean;
  /** 执行日志（供前端进度面板直接展示）。 */
  log: string;
  error?: string;
};

/**
 * 追加日志行（统一清理空白并补换行，避免前端拼接出现格式抖动）。
 */
function appendLog(lines: string[], text: string): void {
  const line = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!line) return;
  lines.push(line);
}

/**
 * 在指定目录创建 Git 仓库（`git init`），并返回结构化结果与可读日志。
 */
export async function initGitRepositoryAsync(args: { dir: string; gitPath?: string; timeoutMs?: number }): Promise<InitGitRepositoryResult> {
  const dir = toFsPathAbs(args?.dir);
  const gitPath = String(args?.gitPath || "").trim() || "git";
  const timeoutMs = Math.max(500, Math.min(60_000, Number(args?.timeoutMs ?? 12_000)));
  const logs: string[] = [];

  if (!dir) {
    appendLog(logs, "[CHECK] 缺少目录参数");
    return { ok: false, dir: "", error: "missing dir", log: logs.join("\n") };
  }

  appendLog(logs, `[CHECK] 目录：${dir}`);
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) {
      appendLog(logs, "[CHECK] 目标不是目录，已终止");
      return { ok: false, dir, error: "target is not a directory", log: logs.join("\n") };
    }
  } catch (e: any) {
    const msg = String(e?.message || e);
    appendLog(logs, `[CHECK] 目录不可用：${msg}`);
    return { ok: false, dir, error: msg, log: logs.join("\n") };
  }

  appendLog(logs, "[STEP 1/2] 检测当前目录是否已位于 Git 工作树");
  const inside = await execGitAsync({
    gitPath,
    argv: ["-C", dir, "rev-parse", "--is-inside-work-tree"],
    timeoutMs,
  });
  if (inside.ok && String(inside.stdout || "").trim() === "true") {
    const top = await execGitAsync({
      gitPath,
      argv: ["-C", dir, "rev-parse", "--show-toplevel"],
      timeoutMs,
    });
    const repoRoot = top.ok ? String(top.stdout || "").trim() : "";
    const br = await execGitAsync({
      gitPath,
      argv: ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"],
      timeoutMs,
    });
    const branch = br.ok ? String(br.stdout || "").trim() : "";
    appendLog(logs, "[DONE] 检测到已存在 Git 仓库，跳过初始化（幂等成功）");
    return { ok: true, dir, repoRoot: repoRoot || undefined, branch: branch || undefined, alreadyRepo: true, log: logs.join("\n") };
  }

  appendLog(logs, "[STEP 2/2] 执行 git init");
  const initRes = await execGitAsync({
    gitPath,
    argv: ["-C", dir, "init"],
    timeoutMs: Math.max(timeoutMs, 15_000),
  });
  if (!initRes.ok) {
    const stderr = String(initRes.stderr || "").trim();
    const stdout = String(initRes.stdout || "").trim();
    const msgRaw = initRes.error || stderr || stdout || "git init failed";
    const msg = isGitExecutableUnavailable(initRes) ? `git 不可用：${msgRaw}` : msgRaw;
    if (stdout) appendLog(logs, `[STDOUT] ${stdout}`);
    if (stderr) appendLog(logs, `[STDERR] ${stderr}`);
    appendLog(logs, `[FAIL] ${msg}`);
    return { ok: false, dir, error: msg, log: logs.join("\n") };
  }

  const initOut = String(initRes.stdout || "").trim();
  if (initOut) appendLog(logs, `[STDOUT] ${initOut}`);
  const initErr = String(initRes.stderr || "").trim();
  if (initErr) appendLog(logs, `[STDERR] ${initErr}`);

  const top = await execGitAsync({
    gitPath,
    argv: ["-C", dir, "rev-parse", "--show-toplevel"],
    timeoutMs,
  });
  const repoRoot = top.ok ? String(top.stdout || "").trim() : dir;
  const br = await execGitAsync({
    gitPath,
    argv: ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"],
    timeoutMs,
  });
  const branch = br.ok ? String(br.stdout || "").trim() : "";
  appendLog(logs, `[DONE] Git 仓库已创建${branch ? `（当前分支：${branch}）` : ""}`);
  return { ok: true, dir, repoRoot: repoRoot || dir, branch: branch || undefined, log: logs.join("\n") };
}
