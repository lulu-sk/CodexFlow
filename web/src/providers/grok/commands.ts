// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AppSettings } from "@/types/host";
import { bashSingleQuote, buildCmdCall, buildPowerShellCall, isCmdTerminal, isWindowsLikeTerminal, splitCommandLineToArgv } from "@/lib/shell";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 解析 Grok Build 的启动命令（为空则回退为 `grok`）。
 */
export function resolveGrokStartupCmd(cmd: string | null | undefined): string {
  const value = String(cmd || "").trim();
  return value || "grok";
}

/**
 * 构造 Grok Build 的会话恢复命令；缺少会话 ID 时恢复当前目录最近会话。
 */
export function buildGrokResumeStartupCmd(args: {
  cmd: string | null | undefined;
  terminalMode: TerminalMode;
  sessionId: string | null | undefined;
}): string {
  const baseCmdRaw = resolveGrokStartupCmd(args.cmd);
  const sessionId = String(args.sessionId || "").trim();
  const resumeArgs = sessionId ? ["--resume", sessionId] : ["--continue"];

  if (isCmdTerminal(args.terminalMode)) {
    const baseArgv = splitCommandLineToArgv(baseCmdRaw);
    return buildCmdCall([...(baseArgv.length > 0 ? baseArgv : ["grok"]), ...resumeArgs]);
  }

  if (isWindowsLikeTerminal(args.terminalMode)) {
    const baseArgv = splitCommandLineToArgv(baseCmdRaw);
    return buildPowerShellCall([...(baseArgv.length > 0 ? baseArgv : ["grok"]), ...resumeArgs]);
  }

  return sessionId
    ? `${baseCmdRaw} --resume ${bashSingleQuote(sessionId)}`
    : `${baseCmdRaw} --continue`;
}
