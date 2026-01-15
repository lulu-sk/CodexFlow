// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AppSettings } from "@/types/host";
import { bashSingleQuote, buildPowerShellCall, isWindowsLikeTerminal, splitCommandLineToArgv } from "@/lib/shell";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 解析 Gemini 的启动命令（为空则回退为 `gemini`）。
 */
export function resolveGeminiStartupCmd(cmd: string | null | undefined): string {
  const v = String(cmd || "").trim();
  return v.length > 0 ? v : "gemini";
}

/**
 * 构造 Gemini 的“继续对话”启动命令：
 * - 优先 `--resume <sessionId>`（若 sessionId 缺失则使用 `latest`）
 * - 适配 WSL（bash）与 Windows（PowerShell）两种执行环境
 */
export function buildGeminiResumeStartupCmd(args: {
  cmd: string | null | undefined;
  terminalMode: TerminalMode;
  sessionId: string | null | undefined;
}): string {
  const baseCmdRaw = resolveGeminiStartupCmd(args.cmd);
  const sid = String(args.sessionId || "").trim();
  const resumeArg = sid.length > 0 ? sid : "latest";

  if (isWindowsLikeTerminal(args.terminalMode)) {
    const baseArgv = splitCommandLineToArgv(baseCmdRaw);
    const base = baseArgv.length > 0 ? baseArgv : ["gemini"];
    return buildPowerShellCall([...base, "--resume", resumeArg]);
  }

  return `${baseCmdRaw} --resume ${bashSingleQuote(resumeArg)}`;
}
