// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { execFileSync, execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WSL 辅助工具: 发行版探测, 路径转换, UNC 映射

export type DistroInfo = { name: string; state?: string; version?: string; isDefault?: boolean };

/** wsl.exe 调用的默认超时（毫秒），避免在 WSL 异常时主进程无限挂起。 */
const DEFAULT_WSL_EXEC_TIMEOUT_MS = 5000;
/** wsl.exe 调用的默认缓冲区上限，避免输出较大时截断。 */
const DEFAULT_WSL_EXEC_MAX_BUFFER = 16 * 1024 * 1024;


function decodeBuffer(buf: Buffer): string {
  // 首选 UTF-8
  try {
    const utf = buf.toString('utf8');
    // 若包含替换字符，尝试 latin1 保留原始字节映射
    if (utf.includes('\uFFFD')) {
      return buf.toString('latin1');
    }
    return utf;
  } catch (e) {
    return buf.toString('latin1');
  }
}

function parseListDistrosOutput(raw: string): DistroInfo[] {
  const lines = raw.split(/\r?\n/).slice(1).filter(Boolean);
  const result: DistroInfo[] = [];
  for (const ln of lines) {
    // 格式:  Ubuntu-22.04  Running 2
    // 去掉 ANSI 转义码和控制字符，规范化空白
    const clean = ln.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (!clean) continue;
    const parts = clean.split(/\s{2,}/).filter(Boolean);
    if (parts.length === 0) continue;
    const rawName = parts[0] || '';
    const isDefault = rawName.trim().startsWith('*');
    // 去掉标识默认的 '*' 以及行尾可能的数字标注，移除奇怪不可见符号
    const nameStripped = rawName.replace(/^\*\s*/, '').replace(/\s+\d+$/, '');
    const name = nameStripped.replace(/[^\x20-\x7E\u4E00-\u9FFF\-_.]/g, '').trim();
    if (!name) continue;
    result.push({
      name,
      state: parts[1],
      version: parts[2],
      isDefault,
    });
  }
  return result;
}

/**
 * 运行 `wsl.exe -l -v` 获取可用发行版列表（带超时），失败返回空数组。
 */
export function listDistros(): DistroInfo[] {
  if (os.platform() !== 'win32') return [];
  try {
    const outBuf = execFileSync('wsl.exe', ['-l', '-v'], { windowsHide: true, timeout: DEFAULT_WSL_EXEC_TIMEOUT_MS, maxBuffer: DEFAULT_WSL_EXEC_MAX_BUFFER });
    const out = decodeBuffer(Buffer.isBuffer(outBuf) ? outBuf : Buffer.from(String(outBuf)));
    return parseListDistrosOutput(out);
  } catch (e) {
    return [];
  }
}

// ---- Async variants (non-blocking main thread) ----

type ExecFilePromiseOptions = {
  /** 超时毫秒数（优先级高于 opts.timeout）。 */
  timeoutMs?: number;
  /** 兼容 Node 原生字段（秒级/毫秒级均由调用方保证）。 */
  timeout?: number;
  /** 是否隐藏窗口（Windows）。 */
  windowsHide?: boolean;
  /** stdout/stderr 缓冲区上限。 */
  maxBuffer?: number;
};

/**
 * 以 Promise 方式执行外部命令（默认带超时），避免主进程无限期等待。
 */
function execFilePromise(cmd: string, args: string[], opts?: ExecFilePromiseOptions): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    try {
      const timeout = Math.max(
        200,
        Math.min(60_000, Number(opts?.timeoutMs ?? opts?.timeout ?? DEFAULT_WSL_EXEC_TIMEOUT_MS)),
      );
      const maxBuffer = Math.max(1024 * 1024, Math.min(64 * 1024 * 1024, Number(opts?.maxBuffer ?? DEFAULT_WSL_EXEC_MAX_BUFFER)));
      const windowsHide = opts?.windowsHide ?? true;
      execFile(cmd, args, { ...opts, windowsHide, timeout, maxBuffer }, (err, stdout, stderr) => {
        if (err) return reject(err);
        const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
        const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '');
        resolve({ stdout: outBuf, stderr: errBuf });
      });
    } catch (e) {
      reject(e);
    }
  });
}

export async function listDistrosAsync(): Promise<DistroInfo[]> {
  if (os.platform() !== 'win32') return [];
  try {
    const { stdout } = await execFilePromise('wsl.exe', ['-l', '-v']);
    const out = decodeBuffer(stdout);
    return parseListDistrosOutput(out);
  } catch (e) {
    return [];
  }
}

/**
 * 在 WSL 发行版中执行命令并返回 stdout（默认带超时；失败返回 null）。
 */
export async function execInWslAsync(
  distro: string | undefined,
  cmd: string,
  options?: { timeoutMs?: number },
): Promise<string | null> {
  if (os.platform() !== 'win32') return null;
  try {
    const args = distro ? ['-d', distro, '--', 'sh', '-lc', cmd] : ['--', 'sh', '-lc', cmd];
    const { stdout } = await execFilePromise('wsl.exe', args, { timeoutMs: options?.timeoutMs });
    const raw = decodeBuffer(stdout);
    const cleaned = raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
    return cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  } catch {
    return null;
  }
}

export async function readFileInWslAsync(distro: string | undefined, wslPath: string): Promise<string | null> {
  const esc = wslPath.replace(/\"/g, '\\"');
  const out = await execInWslAsync(distro, `cat \"${esc}\" 2>/dev/null || true`);
  if (out === null) return null;
  const cleaned = out.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned;
}

/**
 * 规范化 Windows/PowerShell 路径字符串（仅字符串处理，不访问文件系统）。
 * - 去除 PowerShell Provider 前缀：Microsoft.PowerShell.Core\\FileSystem::C:\\...
 * - 兼容长路径前缀：\\\\?\\C:\\... / \\\\?\\UNC\\server\\share\\...
 * - 统一分隔符为 Windows 反斜杠
 */
export function normalizeWinPath(input: string): string {
  try {
    let s = String(input || "").trim();
    if (!s) return "";
    // 去掉外层引号
    s = s.replace(/^["']|["']$/g, "").trim();
    // 合并重复反斜杠：保留 UNC/长路径前缀的起始双反斜杠
    if (s.startsWith("\\\\")) {
      s = "\\\\" + s.slice(2).replace(/\\{2,}/g, "\\");
    } else {
      s = s.replace(/\\{2,}/g, "\\");
    }
    // 去除 PowerShell FileSystem Provider 前缀
    s = s.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, "");
    // 去除 Win32 长路径前缀
    if (s.startsWith("\\\\?\\UNC\\")) {
      s = "\\\\" + s.slice("\\\\?\\UNC\\".length);
    } else if (s.startsWith("\\\\?\\")) {
      s = s.slice("\\\\?\\".length);
    } else if (s.startsWith("\\\\.\\")) {
      s = s.slice("\\\\.\\".length);
    }
    // 统一分隔符
    s = s.replace(/\//g, "\\");
    return s;
  } catch {
    return String(input || "").trim();
  }
}

export async function winToWslAsync(winPath: string, preferredDistro?: string): Promise<string> {
  if (!winPath) return '';
  if (os.platform() !== 'win32') return winPath;
  // 已是 POSIX/WSL 路径，直接返回
  if (/^\//.test(String(winPath).trim())) return String(winPath).trim();
  const normalizedWinPath = normalizeWinPath(winPath);
  try {
    if (isUNCPath(normalizedWinPath)) {
      const u = uncToWsl(normalizedWinPath);
      if (u) return u.wslPath;
    }
  } catch {}
  try {
    // 关键：必须使用 `-e/--exec`，避免默认 shell 解析反斜杠导致 `C:\Users` 变成 `C:Users`（从而刷屏输出 wslpath 错误）。
    const distroArg = preferredDistro ? ['-d', preferredDistro] : [];
    const cmdArgs = [...distroArg, '-e', 'wslpath', '-a', normalizedWinPath];
    const { stdout } = await execFilePromise('wsl.exe', cmdArgs);
    const out = (stdout?.toString('utf8') || '').trim();
    if (out) return out;
  } catch {}
  const m = normalizedWinPath.match(/^([a-zA-Z]):\\(.*)$/);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  return normalizedWinPath;
}

export async function getDistroHomeAsync(distro?: string): Promise<string | null> {
  if (typeof distro === 'undefined') distro = '';
  if (os.platform() !== 'win32') return null;
  try {
    const args = distro ? ['-d', distro, '--', 'sh', '-lc', 'echo $HOME'] : ['--', 'sh', '-lc', 'echo $HOME'];
    const { stdout } = await execFilePromise('wsl.exe', args);
    const out = decodeBuffer(stdout).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 在 WSL 发行版中执行命令并返回 stdout（失败返回 null） */
export function execInWsl(distro: string | undefined, cmd: string): string | null {
  if (os.platform() !== 'win32') return null;
  try {
    // 使用 sh -lc 以兼容更广泛的发行版 shell 权限（部分发行版可能对 bash 存在限制）
    const args = distro ? ['-d', distro, '--', 'sh', '-lc', cmd] : ['--', 'sh', '-lc', cmd];
    const outBuf = execFileSync('wsl.exe', args, { windowsHide: true, timeout: DEFAULT_WSL_EXEC_TIMEOUT_MS, maxBuffer: DEFAULT_WSL_EXEC_MAX_BUFFER });
    const raw = decodeBuffer(Buffer.isBuffer(outBuf) ? outBuf : Buffer.from(String(outBuf)));
    // 去掉 ANSI 控制序列与不可见字符，避免渲染为方块
    const cleaned = raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
    return cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  } catch (e) {
    return null;
  }
}

/** 读取 WSL 内部文件内容（通过 wsl.exe cat），返回字符串或 null */
export function readFileInWsl(distro: string | undefined, wslPath: string): string | null {
  const esc = wslPath.replace(/"/g, '\\"');
  const out = execInWsl(distro, `cat \"${esc}\" 2>/dev/null || true`);
  if (out === null) return null;
  // 进一步清理不可显示字符
  const cleaned = out.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned;
}

/**
 * 尝试使用 wslpath 将 Windows 路径转换为 WSL 绝对路径，失败则使用规则转换
 */
export function winToWsl(winPath: string, preferredDistro?: string): string {
  if (!winPath) return '';
  if (os.platform() !== 'win32') return winPath;
  // 已是 POSIX/WSL 路径，直接返回
  if (/^\//.test(String(winPath).trim())) return String(winPath).trim();
  const normalizedWinPath = normalizeWinPath(winPath);
  // 如果传入的是 UNC 路径，直接转换为 WSL 路径
  try {
    if (isUNCPath(normalizedWinPath)) {
      const u = uncToWsl(normalizedWinPath);
      if (u) return u.wslPath;
    }
  } catch (e) {
    // ignore
  }
  // 优先调用 wsl.exe wslpath -a
  try {
    // 关键：必须使用 `-e/--exec`，避免默认 shell 解析反斜杠导致 `C:\Users` 变成 `C:Users`（从而刷屏输出 wslpath 错误）。
    const distroArg = preferredDistro ? ['-d', preferredDistro] : [];
    const cmdArgs = [...distroArg, '-e', 'wslpath', '-a', normalizedWinPath];
    const out = execFileSync('wsl.exe', cmdArgs, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: DEFAULT_WSL_EXEC_TIMEOUT_MS,
      maxBuffer: DEFAULT_WSL_EXEC_MAX_BUFFER,
    }).trim();
    if (out) return out;
  } catch (e) {
    // 忽略，落回规则转换
  }

  // 规则转换: C:\Users\you -> /mnt/c/Users/you
  const m = normalizedWinPath.match(/^([a-zA-Z]):\\(.*)$/);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  // 网络路径或特殊路径，返回原值
  return normalizedWinPath;
}

/**
 * 将 WSL 绝对路径转换为 Windows UNC 路径，可用于 Node 直接访问
 * 例如: /home/user/.codex -> \\wsl.localhost\Ubuntu-22.04\home\user\.codex
 */
export function wslToUNC(wslPath: string, distro = 'Ubuntu-24.04'): string {
  if (!wslPath) return '';
  // 移除前导/
  let p = wslPath;
  if (p.startsWith('/')) p = p.slice(1);
  // 把 / 替换为 \ 并拼接（UNC 分隔符为单反斜杠）
  const winPath = p.split('/').filter(Boolean).join('\\');
  return `\\\\wsl.localhost\\${distro}\\${winPath}`;
}

/**
 * 判断是否为 WSL UNC 路径（\\wsl.localhost\\Distro\\... 或 \\wsl$\\Distro\\...）
 */
export function isUNCPath(p: string): boolean {
  if (!p) return false;
  // 兼容：
  // - 标准 UNC：\\wsl.localhost\Distro\path（分隔符为单反斜杠）
  // - 历史/内部构造：\\wsl.localhost\\Distro\\path（分隔符为双反斜杠）
  return /^\\\\wsl(?:\.localhost|\$)\\+[^\\]+\\+/i.test(p);
}

/**
 * 将 UNC 路径转换为 WSL 绝对路径:
 * - \\wsl.localhost\Distro\home\you -> /home/you
 * - \\wsl$\Distro\home\you -> /home/you
 */
export function uncToWsl(uncPath: string): { distro: string; wslPath: string } | null {
  if (!isUNCPath(uncPath)) return null;
  // 去掉前导 \\（允许多个反斜杠，兼容单双分隔符混用的历史数据）
  const stripped = uncPath.replace(/^\\\\+/, '');
  const parts = stripped.split(/\\+/).filter(Boolean);
  if (parts.length < 3) return null;
  const distro = parts[1];
  const rest = parts.slice(2).join('/');
  return { distro, wslPath: '/' + rest };
}

/**
 * 获取指定发行版的 home 目录（通过 wsl 执行 echo $HOME）
 */
export function getDistroHome(distro?: string): string | null {
  if (typeof distro === 'undefined') distro = '';
  if (os.platform() !== 'win32') return null;
  try {
    const args = distro ? ['-d', distro, '--', 'sh', '-lc', 'echo $HOME'] : ['--', 'sh', '-lc', 'echo $HOME'];
    const outBuf = execFileSync('wsl.exe', args, { windowsHide: true, timeout: DEFAULT_WSL_EXEC_TIMEOUT_MS, maxBuffer: DEFAULT_WSL_EXEC_MAX_BUFFER });
    const out = decodeBuffer(Buffer.isBuffer(outBuf) ? outBuf : Buffer.from(String(outBuf))).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

/** 返回默认扫描根：Windows ~/code 与每个 WSL 发行版的 home 下 code 目录（以 UNC 返回，便于 Node 访问） */
export function getDefaultRoots(): string[] {
  const roots: string[] = [];
  // 优先使用 WSL 的 .codex 目录及 sessions，其次 Windows 用户的 .codex 与 code
  try {
    const winCodex = path.join(os.homedir(), '.codex');
    roots.push(winCodex);
    // 同时加入 Windows 用户目录下的 code 目录，确保扫描到本机 Windows 工程
    roots.push(path.join(os.homedir(), 'code'));
  } catch (e) {}
  if (os.platform() === 'win32') {
    const ds = listDistros();
    for (const d of ds) {
      const home = getDistroHome(d.name);
      if (home) {
        try {
          const unc = wslToUNC(home, d.name);
          // include UNC home and prioritized codex/sessions
          roots.push(path.join(unc, '.codex'));
          roots.push(path.join(unc, '.codex', 'sessions'));
          roots.push(unc);
          // also include common code folder as lower priority
          roots.push(path.join(unc, 'code'));
        } catch (e) {
          // ignore
        }
      }
    }
  }
  return roots;
}

export async function getDefaultRootsAsync(): Promise<string[]> {
  const roots: string[] = [];
  try {
    const winCodex = path.join(os.homedir(), '.codex');
    roots.push(winCodex);
    roots.push(path.join(os.homedir(), 'code'));
    // 允许通过环境变量注入额外扫描根（分隔符 ; 或 :），例如：CODEX_EXTRA_ROOTS=G:\\Projects;D:\\Workspaces
    try {
      const extra = String((process as any).env.CODEX_EXTRA_ROOTS || '').trim();
      if (extra) {
        for (const seg of extra.split(/[;:]/g)) {
          const s = seg.trim();
          if (s) roots.push(s);
        }
      }
    } catch {}
  } catch {}
  if (os.platform() === 'win32') {
    try {
      const ds = await listDistrosAsync();
      for (const d of ds) {
        const home = await getDistroHomeAsync(d.name);
        if (!home) continue;
        try {
          const unc = wslToUNC(home, d.name);
          roots.push(path.join(unc, '.codex'));
          roots.push(path.join(unc, '.codex', 'sessions'));
          roots.push(unc);
          roots.push(path.join(unc, 'code'));
        } catch {}
      }
    } catch {}
  }
  return roots;
}

/**
 * 快速探测给定发行版是否存在
 */
export function distroExists(name: string): boolean {
  const ds = listDistros();
  return ds.some((d) => d.name.toLowerCase() === name.toLowerCase());
}

export default {
  listDistros,
  listDistrosAsync,
  winToWsl,
  winToWslAsync,
  wslToUNC,
  isUNCPath,
  uncToWsl,
  normalizeWinPath,
  getDistroHome,
  getDistroHomeAsync,
  getDefaultRoots,
  getDefaultRootsAsync,
  distroExists,
  execInWsl,
  execInWslAsync,
  readFileInWsl,
  readFileInWslAsync
};

// ------------------------------
// Fast .codex/.sessions 根路径获取（不扫描项目目录）
// ------------------------------

/** 规范化 WSL UNC 前缀为 \\wsl.localhost\\，并清理多余空白 */
export function normalizeUNC(p: string): string {
  try {
    if (!p) return p;
    let s = String(p).trim();
    // 处理 wsl$ 与 wsl.localhost 差异
    s = s.replace(/^\\\\wsl\$\\/i, "\\\\wsl.localhost\\");
    // 统一分隔符
    s = s.replace(/\//g, "\\");
    // 合并多反斜杠
    s = s.replace(/\\{3,}/g, "\\\\");
    return s;
  } catch {
    return p;
  }
}

/** 获取单个发行版 $HOME/.codex 的 UNC 路径（通过 wslpath -w），失败返回空串 */
export async function getDistroCodexUNCAsync(distro: string): Promise<string> {
  if (os.platform() !== 'win32') return '';
  try {
    const args = ['-d', distro, '--', 'sh', '-lc', 'wslpath -w "$HOME/.codex"'];
    const { stdout } = await (function execFilePromiseLocal() {
      return new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
        try {
          execFile('wsl.exe', args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || '')), stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr || '')) });
          });
        } catch (e) { reject(e); }
      });
    })();
    const raw = decodeBuffer(stdout).trim();
    if (!raw) return '';
    return normalizeUNC(raw);
  } catch {
    return '';
  }
}

/**
 * 获取单个发行版 `$HOME/<subPath>` 的 UNC 路径（通过 `wslpath -w`），失败返回空串。
 * - `subPath` 支持形如 `.claude`、`.gemini/tmp`、`.codex`
 */
export async function getDistroHomeSubPathUNCAsync(distro: string, subPath: string): Promise<string> {
  if (os.platform() !== "win32") return "";
  try {
    const safeSub = String(subPath || "").trim().replace(/^\/+/, "");
    if (!safeSub) return "";
    const target = `$HOME/${safeSub}`;
    const args = ["-d", distro, "--", "sh", "-lc", `wslpath -w "${target}"`];
    const { stdout } = await (function execFilePromiseLocal() {
      return new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
        try {
          execFile("wsl.exe", args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve({
              stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || "")),
              stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr || "")),
            });
          });
        } catch (e) {
          reject(e);
        }
      });
    })();
    const raw = decodeBuffer(stdout).trim();
    if (!raw) return "";
    return normalizeUNC(raw);
  } catch {
    return "";
  }
}

/** 获取所有 Windows 本地与 WSL 发行版的 .codex/.sessions 根（无需扫描） */
export async function getCodexRootsFastAsync(): Promise<{ windowsCodex: string; windowsSessions: string; wsl: { distro: string; codexUNC: string; sessionsUNC: string }[] }> {
  const windowsCodex = path.join(os.homedir(), '.codex');
  const windowsSessions = path.join(windowsCodex, 'sessions');
  const wslRoots: { distro: string; codexUNC: string; sessionsUNC: string }[] = [];
  if (os.platform() === 'win32') {
    try {
      const ds = await listDistrosAsync();
      await Promise.all(ds.map(async (d) => {
        const codexUNC = await getDistroCodexUNCAsync(d.name);
        if (codexUNC) {
          const sessionsUNC = path.join(codexUNC, 'sessions');
          wslRoots.push({ distro: d.name, codexUNC, sessionsUNC });
        }
      }));
    } catch {}
  }
  return { windowsCodex, windowsSessions, wsl: wslRoots };
}

export type SessionsRootCandidate = {
  path: string;
  exists: boolean;
  source: 'windows' | 'wsl';
  distro?: string;
  kind: 'local' | 'unc';
};

async function directoryExists(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function dedupeCandidates(list: SessionsRootCandidate[]): SessionsRootCandidate[] {
  const seen = new Map<string, SessionsRootCandidate>();
  for (const item of list) {
    const key = item.path.replace(/\\/g, '/').toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, item);
    } else {
      const existing = seen.get(key)!;
      if (!existing.exists && item.exists) seen.set(key, item);
    }
  }
  return Array.from(seen.values());
}

export async function getSessionsRootCandidatesFastAsync(): Promise<SessionsRootCandidate[]> {
  const list: SessionsRootCandidate[] = [];
  try {
    const roots = await getCodexRootsFastAsync();
    if (roots.windowsSessions) {
      list.push({
        path: roots.windowsSessions,
        exists: await directoryExists(roots.windowsSessions),
        source: 'windows',
        kind: 'local',
      });
    }
    for (const w of roots.wsl) {
      if (!w.sessionsUNC) continue;
      list.push({
        path: w.sessionsUNC,
        exists: await directoryExists(w.sessionsUNC),
        source: 'wsl',
        distro: w.distro,
        kind: 'unc',
      });
    }
  } catch {}
  if (list.length === 0) {
    try {
      const fallback = path.join(os.homedir(), '.codex', 'sessions');
      list.push({
        path: fallback,
        exists: await directoryExists(fallback),
        source: 'windows',
        kind: 'local',
      });
    } catch {}
  }
  return dedupeCandidates(list);
}

/** 返回所有可用 sessions 根（Windows + 所有 WSL 发行版），不进行目录扫描 */
export async function getSessionsRootsFastAsync(): Promise<string[]> {
  const candidates = await getSessionsRootCandidatesFastAsync();
  return candidates.filter((c) => c.exists).map((c) => c.path);
}
