// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 解析 Claude Code 的启动命令（为空则回退为 `claude`）。
 */
export function resolveClaudeStartupCmd(cmd: string | null | undefined): string {
  const v = String(cmd || "").trim();
  return v.length > 0 ? v : "claude";
}

