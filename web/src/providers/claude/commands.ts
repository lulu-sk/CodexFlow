// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AppSettings } from "@/types/host";
import { bashSingleQuote, buildPowerShellCall, isWindowsLikeTerminal, splitCommandLineToArgv } from "@/lib/shell";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 解析 Claude Code 的启动命令（为空则回退为 `claude`）。
 */
export function resolveClaudeStartupCmd(cmd: string | null | undefined): string {
  const v = String(cmd || "").trim();
  return v.length > 0 ? v : "claude";
}

/**
 * 构造 Claude 的“继续对话”启动命令：
 * - 优先 `--resume <sessionId>`（若可用），失败时回退 `--continue`
 * - 适配 WSL（bash）与 Windows（PowerShell）两种执行环境
 */
export function buildClaudeResumeStartupCmd(args: {
  cmd: string | null | undefined;
  terminalMode: TerminalMode;
  sessionId: string | null | undefined;
}): string {
  const baseCmdRaw = resolveClaudeStartupCmd(args.cmd);
  const sessionId = String(args.sessionId || "").trim();
  const hasSessionId = sessionId.length > 0;

  if (isWindowsLikeTerminal(args.terminalMode)) {
    const baseArgv = splitCommandLineToArgv(baseCmdRaw);
    const base = baseArgv.length > 0 ? baseArgv : ["claude"];
    const cont = buildPowerShellCall([...base, "--continue"]);
    if (!hasSessionId) return cont;
    const resume = buildPowerShellCall([...base, "--resume", sessionId]);
    return `${resume}; if ($LASTEXITCODE -ne 0) { ${cont} }`;
  }

  const cont = `${baseCmdRaw} --continue`;
  if (!hasSessionId) return cont;
  const resume = `${baseCmdRaw} --resume ${bashSingleQuote(sessionId)}`;
  return `${resume} || ${cont}`;
}
