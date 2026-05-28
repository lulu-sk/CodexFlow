// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { execFile } from "node:child_process";
import { normalizeTerminal, type TerminalMode } from "../shells";

export type GeminiExternalEditorShortcut = "ctrlG" | "ctrlX" | "auto";

export type GeminiVersionProbeOptions = {
  terminal?: TerminalMode | string | null;
  distro?: string | null;
  startupCmd?: string | null;
};

export type GeminiVersionProbeResult = {
  ok: boolean;
  shortcut: GeminiExternalEditorShortcut;
  version?: string;
  command?: string;
  error?: string;
};

const GEMINI_CTRL_G_MIN_VERSION = "0.38.0";
const GEMINI_VERSION_PROBE_TIMEOUT_MS = 2500;
const GEMINI_VERSION_PROBE_CACHE_TTL_MS = 60_000;

const versionProbeCache = new Map<string, { checkedAt: number; result: GeminiVersionProbeResult }>();

/**
 * 解析 shell 风格命令的前段 token，覆盖 Gemini 启动命令常见写法。
 *
 * @param commandLine 原始启动命令
 * @returns token 列表
 */
function tokenizeCommandPrefix(commandLine: string): string[] {
  const input = String(commandLine || "").trim();
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "" = "";
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      if (current) tokens.push(current);
      break;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 从 Gemini 启动命令中提取可执行的版本探测命令。
 *
 * @param startupCmd Gemini 启动命令
 * @returns 命令与参数
 */
function resolveGeminiVersionCommand(startupCmd?: string | null): { command: string; args: string[] } {
  const tokens = tokenizeCommandPrefix(String(startupCmd || "gemini"));
  const nonEnvTokens = tokens.filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (nonEnvTokens.length === 0) return { command: "gemini", args: ["--version"] };

  const first = nonEnvTokens[0];
  const firstName = first.replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
  if (firstName === "npx" || firstName === "npx.cmd" || firstName === "npm" || firstName === "npm.cmd") {
    const packageIndex = nonEnvTokens.findIndex((token) => /(^|\/)(@google\/)?gemini-cli($|@)/i.test(token) || /^gemini-cli($|@)/i.test(token));
    if (packageIndex >= 0)
      return { command: first, args: [...nonEnvTokens.slice(1, packageIndex + 1), "--version"] };
  }

  if (/^gemini(?:\.cmd|\.ps1|\.exe)?$/i.test(firstName))
    return { command: first, args: ["--version"] };

  return { command: "gemini", args: ["--version"] };
}

/**
 * 将参数转为 cmd.exe 可安全传递的字符串。
 *
 * @param value 参数值
 * @returns cmd 参数文本
 */
function quoteCmdArg(value: string): string {
  const raw = String(value ?? "");
  if (!raw) return "\"\"";
  if (!/[\s"&<>|^]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

/**
 * 执行版本探测命令并返回输出。
 *
 * @param options 探测参数
 * @returns 标准输出与错误输出合并文本
 */
async function execGeminiVersionCommand(options: GeminiVersionProbeOptions): Promise<{ output: string; command: string }> {
  const terminal = normalizeTerminal(options.terminal);
  const versionCommand = resolveGeminiVersionCommand(options.startupCmd);
  const commandLabel = [versionCommand.command, ...versionCommand.args].join(" ");
  if (terminal === "wsl" && process.platform === "win32") {
    const distro = String(options.distro || "").trim();
    const wslArgs = [
      ...(distro ? ["-d", distro] : []),
      "--",
      versionCommand.command,
      ...versionCommand.args,
    ];
    const output = await execFileText("wsl.exe", wslArgs);
    return { output, command: commandLabel };
  }

  if (process.platform === "win32") {
    const commandLine = [versionCommand.command, ...versionCommand.args].map(quoteCmdArg).join(" ");
    const output = await execFileText("cmd.exe", ["/d", "/s", "/c", commandLine]);
    return { output, command: commandLabel };
  }

  const output = await execFileText(versionCommand.command, versionCommand.args);
  return { output, command: commandLabel };
}

/**
 * 以受限超时执行命令并返回输出文本。
 *
 * @param file 可执行文件
 * @param args 参数列表
 * @returns 输出文本
 */
function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: GEMINI_VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      },
      (error, stdout, stderr) => {
        const output = `${String(stdout || "")}\n${String(stderr || "")}`.trim();
        if (error) {
          const err = new Error(String((error as any)?.message || error));
          (err as any).output = output;
          reject(err);
          return;
        }
        resolve(output);
      },
    );
  });
}

/**
 * 从版本命令输出中提取 Gemini CLI 版本号。
 *
 * @param output 命令输出
 * @returns 版本号
 */
export function parseGeminiCliVersion(output: string): string | null {
  const match = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(String(output || ""));
  return match ? match[1] : null;
}

/**
 * 比较 Gemini CLI 版本号与基准版本。
 *
 * @param version 当前版本
 * @param baseline 基准版本
 * @returns 负数表示低于基准，0 表示同主次补丁版本，正数表示高于基准
 */
function compareGeminiVersionCore(version: string, baseline: string): number {
  const parse = (value: string) => String(value || "").replace(/^v/i, "").split(/[+-]/)[0].split(".").map((part) => Number(part) || 0);
  const left = parse(version);
  const right = parse(baseline);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 根据 Gemini CLI 版本解析外部编辑器快捷键。
 *
 * @param version Gemini CLI 版本
 * @returns 快捷键策略
 */
export function resolveGeminiExternalEditorShortcutFromVersion(version: string | null | undefined): GeminiExternalEditorShortcut {
  const normalized = String(version || "").trim();
  if (!normalized) return "auto";
  return compareGeminiVersionCore(normalized, GEMINI_CTRL_G_MIN_VERSION) >= 0 ? "ctrlG" : "ctrlX";
}

/**
 * 探测当前 Gemini CLI 版本并解析外部编辑器快捷键策略。
 *
 * @param options 探测参数
 * @returns 版本探测结果
 */
export async function resolveGeminiExternalEditorShortcut(options: GeminiVersionProbeOptions): Promise<GeminiVersionProbeResult> {
  const terminal = normalizeTerminal(options.terminal);
  const cacheKey = JSON.stringify({
    terminal,
    distro: terminal === "wsl" ? String(options.distro || "").trim() : "",
    startupCmd: String(options.startupCmd || "gemini").trim(),
  });
  const cached = versionProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < GEMINI_VERSION_PROBE_CACHE_TTL_MS)
    return cached.result;

  try {
    const executed = await execGeminiVersionCommand({ ...options, terminal });
    const version = parseGeminiCliVersion(executed.output);
    const result: GeminiVersionProbeResult = {
      ok: !!version,
      shortcut: resolveGeminiExternalEditorShortcutFromVersion(version),
      version: version || undefined,
      command: executed.command,
      error: version ? undefined : "version not found",
    };
    versionProbeCache.set(cacheKey, { checkedAt: Date.now(), result });
    return result;
  } catch (error: any) {
    const result: GeminiVersionProbeResult = {
      ok: false,
      shortcut: "auto",
      error: String(error?.message || error),
    };
    versionProbeCache.set(cacheKey, { checkedAt: Date.now(), result });
    return result;
  }
}
