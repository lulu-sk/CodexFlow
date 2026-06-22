// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AppSettings } from "@/types/host";
import { bashSingleQuote, buildCmdCall, buildPowerShellCall, isCmdTerminal, isWindowsLikeTerminal, splitCommandLineToArgv } from "@/lib/shell";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 解析 Antigravity CLI 的启动命令（为空则回退为 `agy`）。
 */
export function resolveAntigravityStartupCmd(cmd: string | null | undefined): string {
  const v = String(cmd || "").trim();
  return v.length > 0 ? v : "agy";
}

/**
 * 构造 Antigravity CLI 的“继续对话”启动命令。
 */
export function buildAntigravityResumeStartupCmd(args: {
  cmd: string | null | undefined;
  terminalMode: TerminalMode;
  conversationId: string | null | undefined;
}): string {
  const baseCmdRaw = resolveAntigravityStartupCmd(args.cmd);
  const conversationId = String(args.conversationId || "").trim();
  if (!conversationId) return baseCmdRaw;

  if (isCmdTerminal(args.terminalMode)) {
    const baseArgv = splitCommandLineToArgv(baseCmdRaw);
    const base = baseArgv.length > 0 ? baseArgv : ["agy"];
    return buildCmdCall([...base, "--conversation", conversationId]);
  }

  if (isWindowsLikeTerminal(args.terminalMode)) {
    const baseArgv = splitCommandLineToArgv(baseCmdRaw);
    const base = baseArgv.length > 0 ? baseArgv : ["agy"];
    return buildPowerShellCall([...base, "--conversation", conversationId]);
  }

  return `${baseCmdRaw} --conversation ${bashSingleQuote(conversationId)}`;
}
