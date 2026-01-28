// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AppSettings } from "../types/host";

export type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 将 UTF-8 文本编码为 Base64（用于在 PowerShell 中安全还原包含换行的参数）。
 * 说明：
 * - 在 Node 环境优先使用 `Buffer`（稳定且性能更好）；
 * - 在浏览器环境使用 `TextEncoder` + `btoa`（Electron 渲染进程可用）。
 */
function utf8ToBase64(text: string): string {
  const s = String(text ?? "");
  if (s.length === 0) return "";

  // Node（含 Vitest）环境：优先 Buffer
  try {
    const anyGlobal = globalThis as any;
    if (anyGlobal?.Buffer) {
      return anyGlobal.Buffer.from(s, "utf8").toString("base64");
    }
  } catch {}

  // 浏览器环境：TextEncoder + btoa
  try {
    const bytes = new TextEncoder().encode(s);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...Array.from(chunk));
    }
    return btoa(binary);
  } catch {}

  return "";
}

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
 * 将字符串转换为 PowerShell “可作为单个参数”的安全 token。
 * - 默认使用单引号字面量（无需额外转义 `$`/`` ` `` 等字符）。
 * - 若包含换行（`\r`/`\n`），则使用 UTF-8 Base64 解码表达式生成一行命令，避免 PTY/ConPTY 把多行拆坏。
 */
export function powerShellArgToken(value: string): string {
  const raw = String(value ?? "");
  if (raw.length === 0) return "''";

  if (/[\r\n]/.test(raw)) {
    // 统一为 \n，避免在不同环境中得到 \r\n 影响下游解析
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const b64 = utf8ToBase64(normalized);
    if (b64) {
      return `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${powerShellSingleQuote(b64)})))`;
    }
    return powerShellSingleQuote(normalized);
  }

  return powerShellSingleQuote(raw);
}

/**
 * 基于 argv 构造 PowerShell 调用表达式（使用 call operator `&`）。
 * - 命令与参数会被转换为可安全粘贴/执行的 token（默认单引号；包含换行的参数自动 Base64 编码还原）。
 */
export function buildPowerShellCall(argv: string[]): string {
  const parts = (argv || []).map((x) => String(x || "")).filter((x) => x.length > 0);
  if (parts.length === 0) return "";
  const [cmd, ...args] = parts;
  const rendered = [`& ${powerShellSingleQuote(cmd)}`];
  for (const a of args) rendered.push(powerShellArgToken(a));
  return rendered.join(" ");
}
