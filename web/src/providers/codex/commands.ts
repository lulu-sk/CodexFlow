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
  return `export RUST_LOG=codex_tui=trace; ${base}`;
}

