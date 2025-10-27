// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getSessionsRootsFastAsync, listDistros, execInWslAsync } from './wsl';
import type { DistroInfo } from './wsl';

export type NotificationSettings = {
  /** 任务完成时是否在任务栏显示徽标计数 */
  badge?: boolean;
  /** 任务完成时是否发送系统通知 */
  system?: boolean;
  /** 任务完成时是否播放提示音 */
  sound?: boolean;
};

export type NetworkSettings = {
  /** 是否启用代理（默认启用） */
  proxyEnabled?: boolean;
  /** 代理模式：跟随系统或自定义 */
  proxyMode?: 'system' | 'custom';
  /** 自定义代理地址（如 http://127.0.0.1:7890） */
  proxyUrl?: string;
  /** NO_PROXY 绕过主机列表（逗号分隔） */
  noProxy?: string;
};

export type AppSettings = {
  /** 终端类型：WSL 或 Windows 本地终端 */
  terminal?: 'wsl' | 'windows';
  /** WSL 发行版名称（当 terminal=wsl 时生效） */
  distro: string;
  /** 启动 CodexFlow 的命令（渲染层会做包装） */
  codexCmd: string;
  /** 历史根目录（自动探测） */
  historyRoot: string;
  /** 发送行为：仅写入(write_only) 或 写入并回车(write_and_enter) */
  sendMode?: 'write_only' | 'write_and_enter';
  /** 用户首选语言（可选；为空时按系统语言） */
  locale?: string;
  /** 项目内文件路径样式：absolute=全路径；relative=相对路径（相对项目根） */
  projectPathStyle?: 'absolute' | 'relative';
  /** 任务完成提醒相关偏好 */
  notifications?: NotificationSettings;
  /** 网络代理设置（供主进程与渲染层共享） */
  network?: NetworkSettings;
};

function getStorePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULT_WSL_DISTRO = 'Ubuntu-24.04';
const DISTRO_CACHE_TTL_MS = 30_000;
let cachedDistros: DistroInfo[] | null = null;
let cachedDistrosAt = 0;
const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  badge: true,
  system: true,
  sound: false,
};
const DEFAULT_NETWORK: NetworkSettings = {
  proxyEnabled: true,
  proxyMode: 'system',
  proxyUrl: '',
  noProxy: '',
};

function loadDistroList(): DistroInfo[] {
  if (os.platform() !== 'win32') return [];
  const now = Date.now();
  if (cachedDistros && now - cachedDistrosAt < DISTRO_CACHE_TTL_MS) {
    return cachedDistros;
  }
  try {
    const list = listDistros();
    cachedDistros = Array.isArray(list) ? list : [];
    cachedDistrosAt = now;
    return cachedDistros;
  } catch {
    if (cachedDistros) return cachedDistros;
    return [];
  }
}

function pickPreferredDistro(preferred: unknown, distros: DistroInfo[]): string {
  const normalized = typeof preferred === 'string' ? preferred.trim() : '';
  if (normalized) {
    const hit = distros.find((d) => d.name.toLowerCase() === normalized.toLowerCase());
    if (hit?.name) return hit.name;
  }
  // 优先选择 Ubuntu 系列（满足“优先考虑 Ubuntu”的策略）
  try {
    const ubuntuList = distros.filter((d) => /ubuntu/i.test(d.name));
    if (ubuntuList.length > 0) {
      const def = ubuntuList.find((d) => d.isDefault && d.name);
      if (def?.name) return def.name;
      // 若无默认，按版本号从高到低排序（Ubuntu-24.04 > Ubuntu-22.04 > Ubuntu）
      const parseUbuntuVersion = (name: string): number => {
        const m = name.match(/ubuntu[-_\s]?([0-9]{2})\.([0-9]{2})/i);
        if (!m) return 0;
        return Number(`${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`);
      };
      const sorted = ubuntuList
        .map((d) => ({ d, v: parseUbuntuVersion(d.name) }))
        .sort((a, b) => b.v - a.v);
      const first = sorted[0]?.d?.name || ubuntuList[0]?.name;
      if (first) return first;
    }
  } catch {}
  const markedDefault = distros.find((d) => d.isDefault && d.name);
  if (markedDefault?.name) return markedDefault.name;
  const running = distros.find((d) => (d.state || '').toLowerCase() === 'running' && d.name);
  if (running?.name) return running.name;
  const first = distros.find((d) => !!d.name);
  if (first?.name) return first.name;
  return normalized || DEFAULT_WSL_DISTRO;
}

function mergeWithDefaults(raw: Partial<AppSettings>, preloadedDistros?: DistroInfo[]): AppSettings {
  const distros = preloadedDistros ?? loadDistroList();
  const defaults: AppSettings = {
    terminal: 'wsl',
    distro: pickPreferredDistro('', distros),
    // 渲染层会按“每标签独立 tmux 会话”包装该命令；默认仅保存基础命令
    codexCmd: 'codex',
    historyRoot: path.join(os.homedir(), '.codex', 'sessions'),
    sendMode: 'write_and_enter',
    // 默认：发送给 Codex 的项目内文件路径使用“全路径”（WSL 绝对路径）
    projectPathStyle: 'absolute',
    notifications: { ...DEFAULT_NOTIFICATIONS },
    network: { ...DEFAULT_NETWORK },
  };
  const merged = Object.assign({}, defaults, raw);
  merged.notifications = {
    ...DEFAULT_NOTIFICATIONS,
    ...(raw?.notifications ?? {}),
  };
  merged.network = {
    ...DEFAULT_NETWORK,
    ...(raw as any)?.network,
  };
  merged.distro = pickPreferredDistro(merged.distro, distros);
  return merged;
}

function defaultSettings(): AppSettings {
  const distros = loadDistroList();
  return mergeWithDefaults({}, distros);
}

export function getSettings(): AppSettings {
  try {
    const p = getStorePath();
    const distros = loadDistroList();
    if (!fs.existsSync(p)) return mergeWithDefaults({}, distros);
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw || '{}') as Partial<AppSettings>;
    return mergeWithDefaults(parsed, distros);
  } catch (e) {
    return defaultSettings();
  }
}

export function updateSettings(partial: Partial<AppSettings>) {
  try {
    const distros = loadDistroList();
    const cur = mergeWithDefaults(getSettings(), distros);
    const next = mergeWithDefaults(Object.assign({}, cur, partial), distros);
    fs.writeFileSync(getStorePath(), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    return getSettings();
  }
}

/**
 * 首次运行/路径缺失时自动探测历史目录，并写回设置。
 * 优先顺序：
 *  1) 当前设置的 historyRoot（若存在）
 *  2) Windows 用户目录下 ~/.codex/sessions
 *  3) 每个 WSL 发行版的 $HOME/.codex/sessions（UNC）
 */
export async function ensureSettingsAutodetect(): Promise<AppSettings> {
  const cur = getSettings();
  const exists = (p?: string) => !!p && typeof p === 'string' && fs.existsSync(p);
  if (exists(cur.historyRoot)) return cur;

  const candidates: string[] = [];
  try { candidates.push(path.join(os.homedir(), '.codex', 'sessions')); } catch {}
  try {
    const roots = await getSessionsRootsFastAsync();
    for (const r of roots) { if (r) candidates.push(r); }
  } catch {}

  for (const c of candidates) {
    try { if (exists(c)) return updateSettings({ historyRoot: c }); } catch {}
  }
  return cur;
}

/**
 * 首次运行时：自动选择终端环境（不提示安装）。
 * 规则：
 *  - 优先使用 WSL；在有多个发行版时优先 Ubuntu（版本高者优先）。
 *  - 若未检测到任何 WSL 发行版，但在 PowerShell 可找到 codex，则默认使用 PowerShell。
 *  - 仅在“首次无设置文件或设置缺失 terminal 字段”时写入；否则保持用户选择。
 */
export async function ensureFirstRunTerminalSelection(): Promise<AppSettings> {
  try {
    const storePath = getStorePath();
    const hasStore = fs.existsSync(storePath);
    const current = getSettings();
    // 若已有设置且包含明确的 terminal，视为非首次，无需更改
    if (hasStore && (current.terminal === 'wsl' || current.terminal === 'windows')) {
      return current;
    }

    const distros = loadDistroList();
    // 情况 A：存在 WSL，优先 Ubuntu；若仅 PowerShell 中存在 codex 则选 Windows
    if (os.platform() === 'win32' && Array.isArray(distros) && distros.length > 0) {
      const distro = pickPreferredDistro('', distros);
      const hasPsCodex = (() => {
        try {
          const out = execFileSync('where.exe', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
          return !!String(out || '').trim();
        } catch { return false; }
      })();
      const hasWslCodex = !!(await (async () => {
        try {
          const out = await execInWslAsync(distro, 'command -v codex >/dev/null 2>&1 && echo yes || echo no');
          return (out || '').trim().toLowerCase() === 'yes';
        } catch { return false; }
      })());
      if (hasPsCodex && !hasWslCodex) {
        return updateSettings({ terminal: 'windows' });
      }
      return updateSettings({ terminal: 'wsl', distro });
    }

    // 情况 B：无 WSL，若 PowerShell 中存在 codex，则选 Windows；否则仍写 Windows 以避免 WSL 失败
    const hasPsCodex = (() => {
      if (os.platform() !== 'win32') return false;
      try {
        const out = execFileSync('where.exe', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
        return !!String(out || '').trim();
      } catch { return false; }
    })();
    if (hasPsCodex || os.platform() === 'win32') {
      return updateSettings({ terminal: 'windows' });
    }

    // 其他平台兜底：保持当前合并默认
    return updateSettings({});
  } catch {
    return getSettings();
  }
}

export default { getSettings, updateSettings };


