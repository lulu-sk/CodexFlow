// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getSessionsRootsFastAsync, listDistros, execInWslAsync } from './wsl.js';
import { hasPwsh, normalizeTerminal, type TerminalMode } from './shells.js';
import type { TerminalThemeId } from '@/types/terminal-theme';
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

export type CodexAccountSettings = {
  /** 是否启用“记录账号”（自动备份 ~/.codex/auth.json，用于快速切换） */
  recordEnabled?: boolean;
  /** 按运行环境记录最近一次识别到的“状态+账号ID”签名（避免重复备份） */
  lastSeenSignatureByRuntime?: Record<string, string>;
};

export type ExperimentalSettings = {
  /** 是否启用多实例（Profile）（实验性；全局共享，不随 profile 隔离） */
  multiInstanceEnabled?: boolean;
};

export type ThemeSetting = 'light' | 'dark' | 'system';

export type ProviderId = string;

export type ClaudeCodeSettings = {
  /** 是否读取 Claude Code 的 Agent 历史（agent-*.jsonl 等，不推荐）。 */
  readAgentHistory?: boolean;
};

export type ProviderItem = {
  /** Provider 唯一标识（内置：codex/claude/gemini；自定义：任意非空字符串） */
  id: ProviderId;
  /** 展示名称：仅用于自定义 Provider（内置 Provider 优先由渲染层 i18n 决定） */
  displayName?: string;
  /** 图标（亮色/默认，DataURL，如 data:image/svg+xml;base64,...）；为空则使用内置默认图标 */
  iconDataUrl?: string;
  /** 图标（暗色模式，DataURL）；为空则回退到 iconDataUrl 或内置默认暗色图标 */
  iconDataUrlDark?: string;
  /** 启动命令（例如 codex / claude / gemini），可覆盖内置默认值 */
  startupCmd?: string;
};

export type ProviderEnv = {
  /** 该 Provider 的默认运行环境（与其它 Provider 隔离） */
  terminal?: TerminalMode;
  /** 当 terminal=wsl 时使用的发行版名称 */
  distro?: string;
};

export type ProvidersSettings = {
  /** 当前选中的 Provider（决定后续新建/启动使用的命令拼装方式） */
  activeId: ProviderId;
  /** Provider 列表（包含内置与自定义；内置项用于保存覆盖配置） */
  items: ProviderItem[];
  /** Provider 环境配置（按 id 隔离） */
  env: Record<ProviderId, ProviderEnv>;
};

export type AppSettings = {
  /** 终端类型：WSL 或 Windows 本地终端（PowerShell/PowerShell 7） */
  terminal?: TerminalMode;
  /** 终端配色主题 */
  terminalTheme?: TerminalThemeId;
  /** WSL 发行版名称（当 terminal=wsl 时生效） */
  distro: string;
  /** 启动 CodexFlow 的命令（渲染层会做包装） */
  codexCmd: string;
  /** Provider 设置（可扩展；用于实现多 Provider 与隔离环境） */
  providers?: ProvidersSettings;
  /** 历史根目录（自动探测） */
  historyRoot: string;
  /** 发送行为：仅写入(write_only) 或 写入并回车(write_and_enter) */
  sendMode?: 'write_only' | 'write_and_enter';
  /** 用户首选语言（可选；为空时按系统语言） */
  locale?: string;
  /** 项目内文件路径样式：absolute=全路径；relative=相对路径（相对项目根） */
  projectPathStyle?: 'absolute' | 'relative';
  /** UI 主题：亮色、暗色或跟随系统 */
  theme?: ThemeSetting;
  /** 任务完成提醒相关偏好 */
  notifications?: NotificationSettings;
  /** 网络代理设置（供主进程与渲染层共享） */
  network?: NetworkSettings;
  /** ChatGPT/Codex 账号相关设置（记录账号、切换备份等） */
  codexAccount?: CodexAccountSettings;
  /** 终端字体栈（CSS font-family 字符串） */
  terminalFontFamily?: string;
  /** Claude Code 本地会话读取策略（仅影响索引/预览，不影响 CLI 本身）。 */
  claudeCode?: ClaudeCodeSettings;
  /** 实验性功能开关（注意：该字段不随 profile 隔离；由主进程统一维护） */
  experimental?: ExperimentalSettings;
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
const DEFAULT_CODEX_ACCOUNT: CodexAccountSettings = {
  recordEnabled: false,
  lastSeenSignatureByRuntime: {},
};
const DEFAULT_CLAUDE_CODE: ClaudeCodeSettings = {
  readAgentHistory: false,
};
const DEFAULT_THEME: ThemeSetting = 'system';
const DEFAULT_TERMINAL_THEME: TerminalThemeId = 'campbell';
const DEFAULT_PROVIDER_ACTIVE_ID = 'codex';

function normalizeTheme(raw: unknown): ThemeSetting {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'light' || value === 'dark') return value;
  return DEFAULT_THEME;
}

function normalizeTerminalTheme(raw: unknown): TerminalThemeId {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'dracula') return 'dracula';
  if (value === 'catppuccin-latte' || value === 'catppuccinlatte' || value === 'catppuccin latte' || value === 'catppuccin') {
    return 'catppuccin-latte';
  }
  return DEFAULT_TERMINAL_THEME;
}

/**
 * 归一化 Claude Code 配置：保持结构稳定，避免旧版本缺字段导致逻辑分支散落。
 */
function normalizeClaudeCodeSettings(raw: unknown): ClaudeCodeSettings {
  try {
    const obj = raw && typeof raw === 'object' ? (raw as any) : {};
    return {
      readAgentHistory: obj.readAgentHistory === true,
    };
  } catch {
    return { ...DEFAULT_CLAUDE_CODE };
  }
}

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

/**
 * 生成内置 Provider 列表（仅用于默认值与迁移兜底；渲染层会基于 i18n 决定展示文案）。
 */
function defaultProviderItems(): ProviderItem[] {
  return [
    { id: 'codex' },
    { id: 'claude' },
    { id: 'gemini' },
  ];
}

/**
 * 将 providers 字段归一化为稳定结构，并对旧版本的 terminal/distro/codexCmd 做迁移映射。
 */
function normalizeProviders(raw: Partial<AppSettings>, distros: DistroInfo[]): ProvidersSettings {
  const legacyTerminal = normalizeTerminal((raw as any)?.terminal ?? 'wsl');
  const legacyDistro = pickPreferredDistro((raw as any)?.distro, distros);
  const legacyCodexCmd =
    typeof (raw as any)?.codexCmd === 'string' && String((raw as any).codexCmd).trim().length > 0
      ? String((raw as any).codexCmd).trim()
      : 'codex';

  const input = (raw as any)?.providers as Partial<ProvidersSettings> | undefined;
  const activeId =
    typeof input?.activeId === 'string' && input.activeId.trim().length > 0
      ? input.activeId.trim()
      : DEFAULT_PROVIDER_ACTIVE_ID;

  const itemsInput = Array.isArray(input?.items) ? input!.items : [];
  const items: ProviderItem[] = [];
  const seen = new Set<string>();
  for (const it of itemsInput) {
    const id = typeof (it as any)?.id === 'string' ? String((it as any).id).trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      displayName: typeof (it as any)?.displayName === 'string' ? String((it as any).displayName).trim() : undefined,
      iconDataUrl: typeof (it as any)?.iconDataUrl === 'string' ? String((it as any).iconDataUrl).trim() : undefined,
      iconDataUrlDark: typeof (it as any)?.iconDataUrlDark === 'string' ? String((it as any).iconDataUrlDark).trim() : undefined,
      startupCmd: typeof (it as any)?.startupCmd === 'string' ? String((it as any).startupCmd).trim() : undefined,
    });
  }
  for (const builtIn of defaultProviderItems()) {
    if (seen.has(builtIn.id)) continue;
    seen.add(builtIn.id);
    items.push(builtIn);
  }

  const envInput = (input && typeof input.env === 'object' && input.env) ? (input.env as any) : {};
  const env: Record<string, ProviderEnv> = {};
  for (const [id, val] of Object.entries(envInput || {})) {
    const key = String(id || '').trim();
    if (!key) continue;
    const t = normalizeTerminal((val as any)?.terminal ?? legacyTerminal);
    const d = pickPreferredDistro((val as any)?.distro ?? legacyDistro, distros);
    env[key] = { terminal: t, distro: d };
  }

  // 迁移策略：
  // - codex：使用旧版 terminal/distro/codexCmd 作为默认；允许 providers 覆盖
  // - 其它内置/自定义：若缺失则继承旧版 terminal/distro（仅做初始填充，保证不为空）
  if (!env.codex) env.codex = { terminal: legacyTerminal, distro: legacyDistro };
  if (!env.claude) env.claude = { terminal: legacyTerminal, distro: legacyDistro };
  if (!env.gemini) env.gemini = { terminal: legacyTerminal, distro: legacyDistro };

  // 将 legacyCodexCmd 写入 codex 的 startupCmd 兜底（仅当 providers 未显式覆盖）
  const codexItem = items.find((x) => x.id === 'codex');
  if (codexItem && (!codexItem.startupCmd || codexItem.startupCmd.trim().length === 0)) {
    codexItem.startupCmd = legacyCodexCmd;
  }

  return { activeId, items, env };
}

function mergeWithDefaults(raw: Partial<AppSettings>, preloadedDistros?: DistroInfo[]): AppSettings {
  const distros = preloadedDistros ?? loadDistroList();
  const defaults: AppSettings = {
    terminal: 'wsl',
    terminalTheme: DEFAULT_TERMINAL_THEME,
    distro: pickPreferredDistro('', distros),
    // 渲染层会按“每标签独立 tmux 会话”包装该命令；默认仅保存基础命令
    codexCmd: 'codex',
    providers: {
      activeId: DEFAULT_PROVIDER_ACTIVE_ID,
      items: defaultProviderItems(),
      env: {},
    },
    historyRoot: path.join(os.homedir(), '.codex', 'sessions'),
    sendMode: 'write_and_enter',
    // 默认：发送给 Codex 的项目内文件路径使用“全路径”（WSL 绝对路径）
    projectPathStyle: 'absolute',
    theme: DEFAULT_THEME,
    notifications: { ...DEFAULT_NOTIFICATIONS },
    network: { ...DEFAULT_NETWORK },
    codexAccount: { ...DEFAULT_CODEX_ACCOUNT },
    claudeCode: { ...DEFAULT_CLAUDE_CODE },
  };
  const merged = Object.assign({}, defaults, raw);
  // experimental 由主进程统一维护（全局共享），不写入/不读取 profile settings.json，避免各 profile 状态不一致。
  try { delete (merged as any).experimental; } catch {}
  merged.terminal = normalizeTerminal((raw as any)?.terminal ?? merged.terminal);
  merged.notifications = {
    ...DEFAULT_NOTIFICATIONS,
    ...(raw?.notifications ?? {}),
  };
  merged.network = {
    ...DEFAULT_NETWORK,
    ...(raw as any)?.network,
  };
  merged.codexAccount = (() => {
    try {
      const src = (raw as any)?.codexAccount && typeof (raw as any).codexAccount === 'object' ? (raw as any).codexAccount : {};
      const mapSrc = src.lastSeenSignatureByRuntime && typeof src.lastSeenSignatureByRuntime === 'object' ? src.lastSeenSignatureByRuntime : {};
      const lastSeenSignatureByRuntime: Record<string, string> = {};
      for (const [k, v] of Object.entries(mapSrc)) {
        const key = String(k || '').trim();
        const val = String(v || '').trim();
        if (key && val) lastSeenSignatureByRuntime[key] = val;
      }
      return {
        ...DEFAULT_CODEX_ACCOUNT,
        ...src,
        recordEnabled: src.recordEnabled === true,
        lastSeenSignatureByRuntime,
      } as CodexAccountSettings;
    } catch {
      return { ...DEFAULT_CODEX_ACCOUNT };
    }
  })();
  merged.distro = pickPreferredDistro(merged.distro, distros);
  merged.theme = normalizeTheme((raw as any)?.theme ?? merged.theme);
  merged.terminalTheme = normalizeTerminalTheme((raw as any)?.terminalTheme ?? merged.terminalTheme);
  merged.providers = normalizeProviders(merged, distros);
  merged.claudeCode = normalizeClaudeCodeSettings((merged as any).claudeCode);

  // 与旧字段保持双写兼容：codex provider 的 env/cmd 同步写回 legacy 字段
  try {
    const codexEnv = merged.providers?.env?.codex;
    if (codexEnv?.terminal) merged.terminal = normalizeTerminal(codexEnv.terminal);
    if (codexEnv?.distro) merged.distro = pickPreferredDistro(codexEnv.distro, distros);
    const codexCmd = merged.providers?.items?.find((x) => x.id === 'codex')?.startupCmd;
    if (typeof codexCmd === 'string' && codexCmd.trim().length > 0) merged.codexCmd = codexCmd.trim();
  } catch {}
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
    const mergedRaw: Partial<AppSettings> = Object.assign({}, cur, partial);
    // 对 codexAccount 做浅层合并 + map 合并，避免渲染层只更新 recordEnabled 时意外清空历史签名表
    try {
      const curCodex = (cur as any)?.codexAccount && typeof (cur as any).codexAccount === "object" ? (cur as any).codexAccount : {};
      const nextCodex = (partial as any)?.codexAccount && typeof (partial as any).codexAccount === "object" ? (partial as any).codexAccount : null;
      if (nextCodex) {
        const curMap = curCodex.lastSeenSignatureByRuntime && typeof curCodex.lastSeenSignatureByRuntime === "object" ? curCodex.lastSeenSignatureByRuntime : {};
        const nextMap = nextCodex.lastSeenSignatureByRuntime && typeof nextCodex.lastSeenSignatureByRuntime === "object" ? nextCodex.lastSeenSignatureByRuntime : {};
        (mergedRaw as any).codexAccount = {
          ...curCodex,
          ...nextCodex,
          lastSeenSignatureByRuntime: { ...curMap, ...nextMap },
        };
      }
    } catch {}
    const next = mergeWithDefaults(mergedRaw, distros);
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
    if (hasStore && (current.terminal === 'wsl' || current.terminal === 'windows' || current.terminal === 'pwsh')) {
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
        if (await hasPwsh()) {
          return updateSettings({ terminal: 'pwsh' });
        }
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
      return updateSettings({ terminal: await hasPwsh() ? 'pwsh' : 'windows' });
    }

    // 其他平台兜底：保持当前合并默认
    return updateSettings({});
  } catch {
    return getSettings();
  }
}

export default { getSettings, updateSettings };


