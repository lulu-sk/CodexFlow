// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AppSettings } from "@/types/host";

export type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 判断是否为 Windows 系终端（PowerShell / PowerShell 7）。
 */
export function isWindowsLikeTerminal(mode: TerminalMode): boolean {
  return mode !== "wsl";
}

/**
 * 将用户配置的启动命令拆分为 argv（轻量实现，优先覆盖常见场景：空格分隔、单双引号、反斜杠转义）。
 * - 适用场景：在 PowerShell 中用 call operator 执行带额外参数的命令（避免 "cmd --flag" 作为整体字符串导致无法执行）。
 * - 注意：该解析器不是完整的 bash/pwsh 解析器；若用户在命令中包含复杂的管道/重定向/脚本片段，建议保持简单命令形式。
 */
export function splitCommandLineToArgv(cmd: string | null | undefined): string[] {
  const raw = String(cmd || "").trim();
  if (!raw) return [];

  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let i = 0;

  const push = () => {
    if (!current) return;
    out.push(current);
    current = "";
  };

  while (i < raw.length) {
    const ch = raw[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      // 在双引号内支持 \" 与 \\ 这类转义
      if (quote === '"' && ch === "\\" && i + 1 < raw.length) {
        const next = raw[i + 1];
        current += next;
        i += 2;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      while (i < raw.length && /\s/.test(raw[i])) i += 1;
      continue;
    }

    // 非引号状态下允许用反斜杠转义下一个字符
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      current += next;
      i += 2;
      continue;
    }

    current += ch;
    i += 1;
  }
  push();
  return out;
}

/**
 * 将字符串转换为 Bash 单引号安全字面量。
 */
export function bashSingleQuote(value: string): string {
  const s = String(value ?? "");
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 将字符串转换为 PowerShell 单引号安全字面量。
 */
export function powerShellSingleQuote(value: string): string {
  const s = String(value ?? "");
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 基于 argv 构造 PowerShell 调用表达式（使用 call operator `&`），并对每个 token 做安全单引号包裹。
 */
export function buildPowerShellCall(argv: string[]): string {
  const parts = (argv || []).map((x) => String(x || "")).filter((x) => x.length > 0);
  if (parts.length === 0) return "";
  const [cmd, ...args] = parts;
  const rendered = [`& ${powerShellSingleQuote(cmd)}`];
  for (const a of args) rendered.push(powerShellSingleQuote(a));
  return rendered.join(" ");
}

