// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import wsl, { type DistroInfo } from "./wsl.js";
import { hasPwsh, normalizeTerminal, pickVisibleWindowsTerminalMode, type TerminalMode } from "./shells.js";
import { execFile } from "node:child_process";
import fs from "node:fs";

export type RuntimeEnvInput = {
  terminal?: TerminalMode;
  distro?: string;
};

export type ResolvedRuntimeEnv = {
  terminal: TerminalMode;
  distro: string;
  changed: boolean;
  reason?: "wsl_unavailable" | "wsl_distro_unavailable" | "pwsh_unavailable";
  availableDistros: string[];
};

export type RuntimeCliCheckResult = {
  ok: boolean;
  cli: string;
  terminal: TerminalMode;
  distro: string;
  reason?: "empty_command" | "cli_missing";
  error?: string;
};

type TimedCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const RUNTIME_DISTRO_CACHE_TTL_MS = 5_000;
const CLI_EXISTS_POSITIVE_CACHE_TTL_MS = 10_000;
const CLI_EXISTS_NEGATIVE_CACHE_TTL_MS = 2_000;
const runtimeDistroCache = new Map<string, TimedCacheEntry<DistroInfo[]>>();
const runtimeDistroPending = new Map<string, Promise<DistroInfo[]>>();
const hostCliCache = new Map<string, TimedCacheEntry<boolean>>();
const hostCliPending = new Map<string, Promise<boolean>>();
const wslCliCache = new Map<string, TimedCacheEntry<boolean>>();
const wslCliPending = new Map<string, Promise<boolean>>();

/**
 * 读取仍在有效期内的探测缓存，过期项会被同步清理。
 * @param cache 缓存表
 * @param key 缓存键
 */
function readFreshCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt > Date.now())
    return hit.value;
  cache.delete(key);
  return undefined;
}

/**
 * 写入带过期时间的探测缓存。
 * @param cache 缓存表
 * @param key 缓存键
 * @param value 缓存值
 * @param ttlMs 有效期毫秒数
 */
function writeTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) });
  return value;
}

/**
 * 复制 WSL 发行版列表，避免调用方修改缓存中的对象。
 * @param distros 原始发行版列表
 */
function cloneDistroList(distros: DistroInfo[]): DistroInfo[] {
  return distros.map((item) => ({ ...item }));
}

/**
 * 缓存并合并 WSL 发行版列表探测，避免连续启动时反复调用 wsl.exe。
 */
async function listRuntimeDistrosCached(): Promise<DistroInfo[]> {
  const key = process.platform;
  const cached = readFreshCache(runtimeDistroCache, key);
  if (cached) return cloneDistroList(cached);
  const pending = runtimeDistroPending.get(key);
  if (pending) return cloneDistroList(await pending);

  const next = wsl.listDistrosAsync()
    .then((items) => {
      const list = Array.isArray(items) ? cloneDistroList(items) : [];
      writeTimedCache(runtimeDistroCache, key, list, RUNTIME_DISTRO_CACHE_TTL_MS);
      return list;
    })
    .finally(() => {
      runtimeDistroPending.delete(key);
    });
  runtimeDistroPending.set(key, next);
  return cloneDistroList(await next);
}

/**
 * 根据 CLI 探测结果选择缓存时间：成功稍长，失败更短以便用户安装后快速重试。
 * @param exists CLI 是否存在
 */
function cliExistsCacheTtl(exists: boolean): number {
  return exists ? CLI_EXISTS_POSITIVE_CACHE_TTL_MS : CLI_EXISTS_NEGATIVE_CACHE_TTL_MS;
}

/**
 * 生成宿主 CLI 探测缓存键。
 * @param command CLI 名称或路径
 */
function hostCliCacheKey(command: string): string {
  const normalized = process.platform === "win32" ? command.toLowerCase() : command;
  return `${process.platform}:${normalized}`;
}

/**
 * 生成 WSL CLI 探测缓存键。
 * @param distro WSL 发行版
 * @param command CLI 名称或路径
 */
function wslCliCacheKey(distro: string, command: string): string {
  return `${String(distro || "").trim().toLowerCase()}:${command}`;
}

/**
 * 清理运行环境探测缓存；仅供测试使用。
 */
export function clearRuntimeEnvProbeCachesForTest(): void {
  runtimeDistroCache.clear();
  runtimeDistroPending.clear();
  hostCliCache.clear();
  hostCliPending.clear();
  wslCliCache.clear();
  wslCliPending.clear();
}

/**
 * 将命令行拆成轻量 argv，用于提取首个可执行命令。
 * @param cmd 用户配置或内置生成的启动命令
 */
export function splitRuntimeCommandLine(cmd: string | null | undefined): string[] {
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
      if (quote === '"' && ch === "\\" && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === '"' || next === "\\") {
          current += next;
          i += 2;
          continue;
        }
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

    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (/\s/.test(next) || next === "'" || next === '"' || next === "\\") {
        current += next;
        i += 2;
        continue;
      }
    }

    current += ch;
    i += 1;
  }
  push();
  return out;
}

/**
 * 去掉命令连接符附着在 token 尾部的分号，便于识别实际命令。
 * @param token 命令行 token
 */
function trimRuntimeCommandToken(token: string): string {
  return String(token || "").trim().replace(/;$/, "");
}

/**
 * 判断 token 是否为临时环境变量赋值。
 * @param token 命令行 token
 */
function isRuntimeEnvAssignmentToken(token: string): boolean {
  const value = trimRuntimeCommandToken(token);
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value);
}

/**
 * 从启动命令中提取实际需要检查的 CLI 名称。
 * @param startupCmd Provider 基础启动命令
 */
export function extractRuntimeCliName(startupCmd: string | null | undefined): string {
  const argv = splitRuntimeCommandLine(startupCmd);
  for (const token of argv) {
    const value = trimRuntimeCommandToken(token);
    if (!value) continue;
    const lower = value.toLowerCase();
    if (lower === "set" || lower === "export" || lower === "env") continue;
    if (isRuntimeEnvAssignmentToken(value)) continue;
    if (/^\$env:/i.test(value)) continue;
    if (value === ";" || value === "&&" || value === "||" || value === "&") continue;
    return value;
  }
  return "";
}

/**
 * 将字符串转换为 Bash 单引号字面量。
 * @param value 待转义文本
 */
function bashSingleQuote(value: string): string {
  const s = String(value ?? "");
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 执行原生命令并返回是否成功。
 * @param file 可执行文件
 * @param args 参数列表
 */
async function execFileOk(file: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 2_500, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

/**
 * 判断给定路径是否存在并可作为命令启动。
 * @param command CLI 路径
 */
function hasExecutablePath(command: string): boolean {
  try {
    if (process.platform === "win32")
      return fs.existsSync(command);
    fs.accessSync(command, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断宿主系统当前 PATH 中是否存在指定 CLI。
 * @param cli CLI 名称或可执行文件路径
 */
async function hasHostCli(cli: string): Promise<boolean> {
  const command = String(cli || "").trim();
  if (!command) return false;
  if (/[\\/]/.test(command))
    return hasExecutablePath(command);
  const key = hostCliCacheKey(command);
  const cached = readFreshCache(hostCliCache, key);
  if (typeof cached === "boolean") return cached;
  const pending = hostCliPending.get(key);
  if (pending) return await pending;

  const next = (async () => {
    const exists = process.platform === "win32"
      ? await execFileOk("where.exe", [command])
      : await execFileOk("sh", ["-lc", `command -v -- ${bashSingleQuote(command)} >/dev/null 2>&1`]);
    return writeTimedCache(hostCliCache, key, exists, cliExistsCacheTtl(exists));
  })().finally(() => {
    hostCliPending.delete(key);
  });
  hostCliPending.set(key, next);
  return await next;
}

/**
 * 判断 WSL 当前 PATH 中是否存在指定 CLI。
 * @param distro WSL 发行版
 * @param cli CLI 名称或可执行文件路径
 */
async function hasWslCli(distro: string, cli: string): Promise<boolean> {
  const command = String(cli || "").trim();
  if (!command) return false;
  const key = wslCliCacheKey(distro, command);
  const cached = readFreshCache(wslCliCache, key);
  if (typeof cached === "boolean") return cached;
  const pending = wslCliPending.get(key);
  if (pending) return await pending;

  const quoted = bashSingleQuote(command);
  const script = command.includes("/")
    ? `test -x ${quoted} && echo yes || echo no`
    : `command -v -- ${quoted} >/dev/null 2>&1 && echo yes || echo no`;
  const next = wsl.execInWslAsync(distro, script, { timeoutMs: 3_000 })
    .then((out) => {
      const exists = String(out || "").trim().toLowerCase() === "yes";
      return writeTimedCache(wslCliCache, key, exists, cliExistsCacheTtl(exists));
    })
    .finally(() => {
      wslCliPending.delete(key);
    });
  wslCliPending.set(key, next);
  return await next;
}

/**
 * 从发行版列表中选择一个可见发行版。
 * @param preferred 用户配置中的发行版名称
 * @param distros 当前可用发行版列表
 */
function pickVisibleDistro(preferred: string, distros: DistroInfo[]): string {
  const normalized = String(preferred || "").trim();
  if (normalized) {
    const hit = distros.find((item) => String(item?.name || "").toLowerCase() === normalized.toLowerCase());
    if (hit?.name) return hit.name;
  }

  const ubuntu = distros.filter((item) => /ubuntu/i.test(String(item?.name || "")));
  const ubuntuDefault = ubuntu.find((item) => item.isDefault && item.name);
  if (ubuntuDefault?.name) return ubuntuDefault.name;

  const parseUbuntuVersion = (name: string): number => {
    const match = String(name || "").match(/ubuntu[-_\s]?([0-9]{2})\.([0-9]{2})/i);
    if (!match) return 0;
    return Number(`${match[1].padStart(2, "0")}${match[2].padStart(2, "0")}`);
  };
  const sortedUbuntu = ubuntu
    .map((item) => ({ item, version: parseUbuntuVersion(item.name) }))
    .sort((a, b) => b.version - a.version);
  if (sortedUbuntu[0]?.item?.name) return sortedUbuntu[0].item.name;

  const markedDefault = distros.find((item) => item.isDefault && item.name);
  if (markedDefault?.name) return markedDefault.name;
  const running = distros.find((item) => String(item?.state || "").toLowerCase() === "running" && item.name);
  if (running?.name) return running.name;
  return distros.find((item) => !!item.name)?.name || normalized;
}

/**
 * 将请求的终端环境解析为当前机器上可见的环境。
 * @param input 请求使用的终端环境
 */
export async function resolveVisibleRuntimeEnv(input: RuntimeEnvInput): Promise<ResolvedRuntimeEnv> {
  const requestedTerminal = normalizeTerminal(input.terminal);
  const requestedDistro = String(input.distro || "").trim();

  if (process.platform !== "win32") {
    return {
      terminal: requestedTerminal,
      distro: requestedDistro,
      changed: false,
      availableDistros: [],
    };
  }

  const distros = await listRuntimeDistrosCached();
  const availableDistros = distros.map((item) => String(item?.name || "").trim()).filter(Boolean);

  if (requestedTerminal === "wsl") {
    if (distros.length <= 0) {
      return {
        terminal: await pickVisibleWindowsTerminalMode(),
        distro: requestedDistro,
        changed: true,
        reason: "wsl_unavailable",
        availableDistros,
      };
    }

    const distro = pickVisibleDistro(requestedDistro, distros);
    const changed = !!requestedDistro && distro.toLowerCase() !== requestedDistro.toLowerCase();
    return {
      terminal: "wsl",
      distro,
      changed,
      reason: changed ? "wsl_distro_unavailable" : undefined,
      availableDistros,
    };
  }

  if (requestedTerminal === "pwsh" && !(await hasPwsh())) {
    return {
      terminal: "windows",
      distro: requestedDistro,
      changed: true,
      reason: "pwsh_unavailable",
      availableDistros,
    };
  }

  return {
    terminal: requestedTerminal,
    distro: requestedDistro,
    changed: false,
    availableDistros,
  };
}

/**
 * 检查指定运行环境中是否能找到 Provider 要启动的 CLI。
 * @param input 运行环境与启动命令
 */
export async function checkRuntimeCli(input: RuntimeEnvInput & { startupCmd?: string }): Promise<RuntimeCliCheckResult> {
  const resolved = await resolveVisibleRuntimeEnv(input);
  const cli = extractRuntimeCliName(input.startupCmd);
  if (!cli) {
    return {
      ok: true,
      cli: "",
      terminal: resolved.terminal,
      distro: resolved.distro,
      reason: "empty_command",
    };
  }

  const exists = process.platform === "win32" && resolved.terminal === "wsl"
    ? await hasWslCli(resolved.distro, cli)
    : await hasHostCli(cli);
  if (exists) {
    return {
      ok: true,
      cli,
      terminal: resolved.terminal,
      distro: resolved.distro,
    };
  }

  return {
    ok: false,
    cli,
    terminal: resolved.terminal,
    distro: resolved.distro,
    reason: "cli_missing",
    error: `${cli} not found`,
  };
}
