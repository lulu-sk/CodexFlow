// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AppSettings } from "@/types/host";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 为 Codex CLI 注入 TUI trace 环境变量（仅在启用调试开关时生效）。
 */
export function injectCodexTraceEnv(args: {
  cmd: string | null | undefined;
  traceEnabled: boolean;
  terminalMode: TerminalMode;
}): string {
  const raw = String(args.cmd || "").trim();
  const base = raw.length > 0 ? raw : "codex";
  if (!args.traceEnabled) return base;

  const isWindowsLike = args.terminalMode !== "wsl";
  if (isWindowsLike) {
    if (/RUST_LOG\s*=/.test(base) || base.includes("$env:RUST_LOG")) {
      return base;
    }
    return `$env:RUST_LOG='codex_tui=trace'; ${base}`;
  }

  if (/RUST_LOG\s*=/.test(base) || (base.startsWith("export ") && base.includes("RUST_LOG="))) {
    return base;
  }
  // WSL 下避免使用 `export ...; cmd` 这种带分号的形式：Windows Terminal 的 `wt.exe` 会把 `;` 当作命令分隔符，
  // 可能导致外部控制台启动时把脚本拆成多个“命令”，从而连开多个窗口并报错。
  return `RUST_LOG=codex_tui=trace ${base}`;
}
