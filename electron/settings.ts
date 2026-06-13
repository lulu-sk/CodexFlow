// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import os from 'node:os';
import { getSessionsRootsFastAsync, listDistros } from './wsl.js';
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
  /** 子代理完成时是否也发送提醒（默认关闭） */
  subagent?: boolean;
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

export type CodexErrorHandlingSettings = {
  /** 是否识别 Codex TUI/CLI 输出中的错误文本 */
  detectionEnabled?: boolean;
  /** 是否在 Codex 仍处于 Reconnecting 阶段时也发送通知 */
  notifyReconnectErrors?: boolean;
  /** 是否在可恢复错误后自动发送 continue */
  autoContinueEnabled?: boolean;
  /** 自动 continue 适用的可恢复错误类型 */
  autoContinueErrorKinds?: Array<'rateLimited' | 'concurrency' | 'networkStream' | 'badGateway' | 'serviceUnavailable' | 'highDemand' | 'modelCapacity' | 'forbidden' | 'badRequest' | 'payloadTooLarge'>;
  /** 自动 continue 错误类型列表版本，用于一次性默认项迁移 */
  autoContinueErrorKindsVersion?: number;
  /** 自动发送 continue 前等待的秒数 */
  autoContinueDelaySeconds?: number;
  /** 单个错误连续自动 continue 的最大次数 */
  autoContinueMaxAttempts?: number;
};

export type DragDropSettings = {
  /** 拖拽添加的资源不在当前项目目录时提醒（默认开启） */
  warnOutsideProject?: boolean;
};

export type ExperimentalSettings = {
  /** 是否启用多实例（Profile）（实验性；全局共享，不随 profile 隔离） */
  multiInstanceEnabled?: boolean;
};

export type ExternalGitToolId = 'rider' | 'sourcetree' | 'fork' | 'gitkraken' | 'custom';

export type ExternalGitToolSettings = {
  /** 外部 Git 工具类型 */
  id?: ExternalGitToolId;
  /** 自定义命令（仅当 id=custom 时使用；支持占位符 {path}） */
  customCommand?: string;
};

export type GitWorktreeSettings = {
  /** Git 可执行文件路径；为空表示自动探测（使用 PATH 中的 git） */
  gitPath?: string;
  /** 默认外部 Git 工具 */
  externalGitTool?: ExternalGitToolSettings;
  /** “在此目录打开终端/Git Bash”的自定义命令（支持占位符 {path}；为空走默认策略） */
  terminalCommand?: string;
  /** worktree 自动提交开关（仅对 worktree 生效；主工作区不触发） */
  autoCommitEnabled?: boolean;
  /** 创建 worktree 时自动拷贝 AI 规则文件（AGENTS/CLAUDE/GEMINI） */
  copyRulesOnCreate?: boolean;
};

export type BuiltinIdeId = "vscode" | "cursor" | "windsurf" | "rider";

export type IdeOpenSettings = {
  /** 默认 IDE 模式：auto=自动探测；builtin=固定内置 IDE；custom=自定义命令模板。 */
  mode?: "auto" | "builtin" | "custom";
  /** 内置 IDE 标识（mode=builtin 时生效）。 */
  builtinId?: BuiltinIdeId;
  /** 自定义 IDE 展示名（可选，仅用于界面展示）。 */
  customName?: string;
  /** 自定义 IDE 命令模板（mode=custom 时生效）。 */
  customCommand?: string;
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
  /** Codex TUI/CLI 错误识别与自动 continue 设置 */
  codexErrorHandling?: CodexErrorHandlingSettings;
  /** 终端字体栈（CSS font-family 字符串） */
  terminalFontFamily?: string;
  /** Claude Code 本地会话读取策略（仅影响索引/预览，不影响 CLI 本身）。 */
  claudeCode?: ClaudeCodeSettings;
  /** 拖拽/粘贴等输入相关偏好 */
  dragDrop?: DragDropSettings;
  /** 实验性功能开关（注意：该字段不随 profile 隔离；由主进程统一维护） */
  experimental?: ExperimentalSettings;
  /** git worktree 相关设置（仅影响 worktree/Build-Run 等功能，不影响 Provider/PTY 既有策略） */
  gitWorktree?: GitWorktreeSettings;
  /** 默认 IDE 打开策略（用于“文件定位跳转”链路）。 */
  ideOpen?: IdeOpenSettings;
};

function getStorePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * 判断设置文件是否已经存在。
 */
export function hasSettingsStore(): boolean {
  try {
    return fs.existsSync(getStorePath());
  } catch {
    return false;
  }
}

/**
 * 判断用户是否已经保存过明确的终端环境选择。
 */
export function hasSavedRuntimeEnvSelection(): boolean {
  try {
    const storePath = getStorePath();
    if (!fs.existsSync(storePath)) return false;
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8') || '{}') as any;
    if (typeof raw?.terminal === 'string' && raw.terminal.trim().length > 0) return true;
    const env = raw?.providers?.env;
    if (!env || typeof env !== 'object') return false;
    return Object.values(env).some((value: any) => typeof value?.terminal === 'string' && value.terminal.trim().length > 0);
  } catch {
    return false;
  }
}

const DEFAULT_WSL_DISTRO = 'Ubuntu-24.04';
const DISTRO_CACHE_TTL_MS = 30_000;
let cachedDistros: DistroInfo[] | null = null;
let cachedDistrosAt = 0;
const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  badge: true,
  system: true,
  sound: true,
  subagent: false,
};
const DEFAULT_NETWORK: NetworkSettings = {
  proxyEnabled: true,
  proxyMode: 'system',
  proxyUrl: '',
  noProxy: '',
};
const DEFAULT_DRAG_DROP: DragDropSettings = {
  warnOutsideProject: true,
};
const DEFAULT_CODEX_ACCOUNT: CodexAccountSettings = {
  recordEnabled: false,
  lastSeenSignatureByRuntime: {},
};
const DEFAULT_CODEX_ERROR_HANDLING: Required<CodexErrorHandlingSettings> = {
  detectionEnabled: true,
  notifyReconnectErrors: false,
  autoContinueEnabled: false,
  autoContinueErrorKinds: ['networkStream', 'rateLimited', 'concurrency', 'modelCapacity', 'badGateway', 'serviceUnavailable', 'highDemand', 'forbidden', 'badRequest'],
  autoContinueErrorKindsVersion: 3,
  autoContinueDelaySeconds: 30,
  autoContinueMaxAttempts: 5,
};
const CODEX_AUTO_CONTINUE_ERROR_KINDS: Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'] = [
  ...DEFAULT_CODEX_ERROR_HANDLING.autoContinueErrorKinds,
  'payloadTooLarge',
];
const CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION = 3;
const LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V1: Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'] = [
  'networkStream',
  'rateLimited',
  'concurrency',
  'badGateway',
  'serviceUnavailable',
];
const LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V2: Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'] = [
  'networkStream',
  'rateLimited',
  'concurrency',
  'modelCapacity',
  'badGateway',
  'serviceUnavailable',
  'forbidden',
  'badRequest',
];
const DEFAULT_CLAUDE_CODE: ClaudeCodeSettings = {
  readAgentHistory: false,
};
const DEFAULT_THEME: ThemeSetting = 'system';
const DEFAULT_TERMINAL_THEME: TerminalThemeId = 'campbell';
const DEFAULT_PROVIDER_ACTIVE_ID = 'codex';
const DEFAULT_GIT_WORKTREE: Required<GitWorktreeSettings> = {
  gitPath: '',
  externalGitTool: { id: 'rider', customCommand: '' },
  terminalCommand: '',
  autoCommitEnabled: true,
  copyRulesOnCreate: true,
};
const DEFAULT_IDE_OPEN: Required<IdeOpenSettings> = {
  mode: "auto",
  builtinId: "cursor",
  customName: "",
  customCommand: "",
};

/**
 * 归一化内置 IDE 标识，非法时回退为 null。
 */
function normalizeBuiltinIdeId(raw: unknown): BuiltinIdeId | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "vscode" || value === "cursor" || value === "windsurf" || value === "rider") {
    return value as BuiltinIdeId;
  }
  return null;
}

/**
 * 归一化默认 IDE 设置：保证结构稳定，避免旧版本/脏数据导致逻辑分支散落。
 */
function normalizeIdeOpenSettings(raw: unknown): IdeOpenSettings {
  try {
    const obj = raw && typeof raw === "object" ? (raw as any) : {};
    const modeRaw = typeof obj.mode === "string" ? obj.mode.trim().toLowerCase() : "";
    const builtinId = normalizeBuiltinIdeId(obj.builtinId) || DEFAULT_IDE_OPEN.builtinId;
    const customName = typeof obj.customName === "string" ? obj.customName.trim() : "";
    const customCommand = typeof obj.customCommand === "string" ? obj.customCommand.trim() : "";

    if (modeRaw === "builtin") {
      return {
        mode: "builtin",
        builtinId,
        customName: "",
        customCommand: "",
      };
    }

    if (modeRaw === "custom") {
      if (!customCommand) return { ...DEFAULT_IDE_OPEN };
      return {
        mode: "custom",
        builtinId,
        customName,
        customCommand,
      };
    }

    if (modeRaw === "auto") {
      return {
        mode: "auto",
        builtinId,
        customName: "",
        customCommand: "",
      };
    }

    // 兼容旧数据：无 mode 但有具体字段。
    if (customCommand) {
      return {
        mode: "custom",
        builtinId,
        customName,
        customCommand,
      };
    }
    if (normalizeBuiltinIdeId(obj.builtinId)) {
      return {
        mode: "builtin",
        builtinId,
        customName: "",
        customCommand: "",
      };
    }
    return { ...DEFAULT_IDE_OPEN };
  } catch {
    return { ...DEFAULT_IDE_OPEN };
  }
}

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
 * 将输入值归一化为指定下限和可选上限内的整数。
 */
function normalizeBoundedInteger(raw: unknown, fallback: number, min: number, max?: number): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  const lowerBounded = Math.max(min, rounded);
  return typeof max === 'number' ? Math.min(max, lowerBounded) : lowerBounded;
}

/**
 * 归一化自动 continue 错误类型列表版本，缺失版本按旧配置处理。
 */
function normalizeCodexAutoContinueErrorKindsVersion(raw: unknown): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION, Math.floor(numeric));
}

/**
 * 判断两个错误类型列表是否包含同一组类型。
 */
function hasSameCodexAutoContinueErrorKinds(
  left: Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'],
  right: Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'],
): boolean {
  return (
    left.length === right.length &&
    right.every((kind) => left.includes(kind))
  );
}

/**
 * 判断旧配置是否仍是当时版本的默认全选列表。
 */
function shouldUpgradeLegacyCodexAutoContinueDefaultKinds(
  kinds: Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'],
  version: number,
): boolean {
  if (version < 2 && hasSameCodexAutoContinueErrorKinds(kinds, LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V1)) return true;
  if (version < 3 && hasSameCodexAutoContinueErrorKinds(kinds, LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V2)) return true;
  return false;
}

/**
 * 归一化自动 continue 错误类型列表，保留用户显式清空的选择。
 */
function normalizeCodexAutoContinueErrorKinds(raw: unknown, version: number): Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'] {
  if (!Array.isArray(raw)) return [...DEFAULT_CODEX_ERROR_HANDLING.autoContinueErrorKinds];
  const allowed = new Set(CODEX_AUTO_CONTINUE_ERROR_KINDS);
  const next: Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'] = [];
  for (const item of raw) {
    const kind = String(item || '').trim() as Required<CodexErrorHandlingSettings>['autoContinueErrorKinds'][number];
    if (!allowed.has(kind) || next.includes(kind)) continue;
    next.push(kind);
  }
  if (shouldUpgradeLegacyCodexAutoContinueDefaultKinds(next, version)) {
    return [...DEFAULT_CODEX_ERROR_HANDLING.autoContinueErrorKinds];
  }
  return next;
}

/**
 * 归一化 Codex 错误处理设置：补齐默认值并限制自动 continue 参数范围。
 */
function normalizeCodexErrorHandlingSettings(raw: unknown): CodexErrorHandlingSettings {
  try {
    const obj = raw && typeof raw === 'object' ? (raw as any) : {};
    const autoContinueErrorKindsVersion = normalizeCodexAutoContinueErrorKindsVersion(obj.autoContinueErrorKindsVersion);
    return {
      detectionEnabled: obj.detectionEnabled !== false,
      notifyReconnectErrors: obj.notifyReconnectErrors === true,
      autoContinueEnabled: obj.autoContinueEnabled === true,
      autoContinueErrorKinds: normalizeCodexAutoContinueErrorKinds(obj.autoContinueErrorKinds, autoContinueErrorKindsVersion),
      autoContinueErrorKindsVersion: CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION,
      autoContinueDelaySeconds: normalizeBoundedInteger(obj.autoContinueDelaySeconds, DEFAULT_CODEX_ERROR_HANDLING.autoContinueDelaySeconds, 5, 600),
      autoContinueMaxAttempts: normalizeBoundedInteger(obj.autoContinueMaxAttempts, DEFAULT_CODEX_ERROR_HANDLING.autoContinueMaxAttempts, 0),
    };
  } catch {
    return { ...DEFAULT_CODEX_ERROR_HANDLING };
  }
}

/**
 * 归一化 git worktree 设置：补齐默认字段，并收敛可选枚举，避免旧版本/脏数据导致主流程分支散落。
 */
function normalizeGitWorktreeSettings(raw: unknown): GitWorktreeSettings {
  try {
    const obj = raw && typeof raw === 'object' ? (raw as any) : {};
    const gitPath = typeof obj.gitPath === 'string' ? obj.gitPath.trim() : '';
    const terminalCommand = typeof obj.terminalCommand === 'string' ? obj.terminalCommand.trim() : '';
    const autoCommitEnabled = obj.autoCommitEnabled !== false;
    const copyRulesOnCreate = obj.copyRulesOnCreate !== false;

    const toolRaw = obj.externalGitTool && typeof obj.externalGitTool === 'object' ? obj.externalGitTool : {};
    const idRaw = typeof toolRaw.id === 'string' ? toolRaw.id.trim().toLowerCase() : '';
    const id: ExternalGitToolId =
      idRaw === 'sourcetree'
        ? 'sourcetree'
        : idRaw === 'fork'
          ? 'fork'
          : idRaw === 'gitkraken'
            ? 'gitkraken'
            : idRaw === 'custom'
              ? 'custom'
              : 'rider';
    const customCommand = typeof toolRaw.customCommand === 'string' ? toolRaw.customCommand.trim() : '';

    return {
      ...DEFAULT_GIT_WORKTREE,
      gitPath,
      terminalCommand,
      autoCommitEnabled,
      copyRulesOnCreate,
      externalGitTool: { id, customCommand },
    };
  } catch {
    return { ...DEFAULT_GIT_WORKTREE };
  }
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
    codexErrorHandling: { ...DEFAULT_CODEX_ERROR_HANDLING },
    dragDrop: { ...DEFAULT_DRAG_DROP },
    claudeCode: { ...DEFAULT_CLAUDE_CODE },
    gitWorktree: { ...DEFAULT_GIT_WORKTREE },
    ideOpen: { ...DEFAULT_IDE_OPEN },
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
  merged.dragDrop = (() => {
    try {
      const src = (raw as any)?.dragDrop && typeof (raw as any).dragDrop === 'object' ? (raw as any).dragDrop : {};
      return {
        ...DEFAULT_DRAG_DROP,
        ...src,
        warnOutsideProject: src.warnOutsideProject !== false,
      } as DragDropSettings;
    } catch {
      return { ...DEFAULT_DRAG_DROP };
    }
  })();
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
  merged.codexErrorHandling = normalizeCodexErrorHandlingSettings((raw as any)?.codexErrorHandling);
  merged.distro = pickPreferredDistro(merged.distro, distros);
  merged.theme = normalizeTheme((raw as any)?.theme ?? merged.theme);
  merged.terminalTheme = normalizeTerminalTheme((raw as any)?.terminalTheme ?? merged.terminalTheme);
  merged.providers = normalizeProviders(merged, distros);
  merged.claudeCode = normalizeClaudeCodeSettings((merged as any).claudeCode);
  merged.gitWorktree = normalizeGitWorktreeSettings((raw as any)?.gitWorktree);
  merged.ideOpen = normalizeIdeOpenSettings((raw as any)?.ideOpen);

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
    // 对 dragDrop 做浅层合并，避免渲染层只更新单个字段时覆盖其它子字段
    try {
      const curDrag = (cur as any)?.dragDrop && typeof (cur as any).dragDrop === "object" ? (cur as any).dragDrop : {};
      const nextDrag = (partial as any)?.dragDrop && typeof (partial as any).dragDrop === "object" ? (partial as any).dragDrop : null;
      if (nextDrag) {
        (mergedRaw as any).dragDrop = {
          ...curDrag,
          ...nextDrag,
        };
      }
    } catch {}
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
    // 对 gitWorktree 做浅层合并 + externalGitTool 子对象合并，避免局部更新覆盖其它字段
    try {
      const curGt = (cur as any)?.gitWorktree && typeof (cur as any).gitWorktree === 'object' ? (cur as any).gitWorktree : {};
      const nextGt = (partial as any)?.gitWorktree && typeof (partial as any).gitWorktree === 'object' ? (partial as any).gitWorktree : null;
      if (nextGt) {
        const curTool = curGt.externalGitTool && typeof curGt.externalGitTool === 'object' ? curGt.externalGitTool : {};
        const nextTool = nextGt.externalGitTool && typeof nextGt.externalGitTool === 'object' ? nextGt.externalGitTool : null;
        (mergedRaw as any).gitWorktree = {
          ...curGt,
          ...nextGt,
          externalGitTool: nextTool ? { ...curTool, ...nextTool } : curTool,
        };
      }
    } catch {}
    // 对 ideOpen 做浅层合并，避免渲染层仅更新单字段时覆盖其它字段
    try {
      const curIde = (cur as any)?.ideOpen && typeof (cur as any).ideOpen === "object" ? (cur as any).ideOpen : {};
      const nextIde = (partial as any)?.ideOpen && typeof (partial as any).ideOpen === "object" ? (partial as any).ideOpen : null;
      if (nextIde) {
        (mergedRaw as any).ideOpen = {
          ...curIde,
          ...nextIde,
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
 *  - 若未检测到任何 WSL 发行版，则优先使用 PowerShell 7，否则使用 Windows PowerShell。
 *  - 仅在“首次无设置文件或设置缺失 terminal 字段”时写入；否则保持用户选择。
 */
export async function ensureFirstRunTerminalSelection(): Promise<AppSettings> {
  try {
    const storePath = getStorePath();
    const hasStore = fs.existsSync(storePath);
    const current = getSettings();
    // 若已有设置且包含明确的 terminal，视为非首次，无需更改
    if (hasStore && (current.terminal === 'wsl' || current.terminal === 'windows' || current.terminal === 'pwsh' || current.terminal === 'cmd')) {
      return current;
    }

    const distros = loadDistroList();
    // 情况 A：存在 WSL，首次直接选择可见 WSL，不混入 CLI 是否安装的判断。
    if (os.platform() === 'win32' && Array.isArray(distros) && distros.length > 0) {
      const distro = pickPreferredDistro('', distros);
      return updateSettings({ terminal: 'wsl', distro });
    }

    // 情况 B：无 WSL，优先 PowerShell 7，否则 Windows PowerShell。
    if (os.platform() === 'win32') {
      return updateSettings({ terminal: await hasPwsh() ? 'pwsh' : 'windows' });
    }

    // 其他平台兜底：保持当前合并默认
    return updateSettings({});
  } catch {
    return getSettings();
  }
}

export default { getSettings, updateSettings, hasSettingsStore, hasSavedRuntimeEnvSelection };


