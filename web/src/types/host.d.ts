// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TerminalThemeId } from "./terminal-theme";

export {}; // make this a module

// 与主进程约定的类型（仅做声明，不引入运行时依赖）
export type ThemeSetting = 'light' | 'dark' | 'system';

export type ProviderId = string;

export type ProviderItem = {
  id: ProviderId;
  displayName?: string;
  iconDataUrl?: string;
  startupCmd?: string;
};

export type ProviderEnv = {
  terminal?: 'wsl' | 'windows' | 'pwsh';
  distro?: string;
};

export type ClaudeCodeSettings = {
  readAgentHistory?: boolean;
};

export type ProvidersSettings = {
  activeId: ProviderId;
  items: ProviderItem[];
  env: Record<ProviderId, ProviderEnv>;
};

export type AppSettings = {
  terminal?: 'wsl' | 'windows' | 'pwsh';
  terminalTheme?: TerminalThemeId;
  distro: string;
  codexCmd: string;
  providers?: ProvidersSettings;
  claudeCode?: ClaudeCodeSettings;
  historyRoot: string;
  sendMode?: 'write_only' | 'write_and_enter';
  locale?: string;
  projectPathStyle?: 'absolute' | 'relative';
  theme?: ThemeSetting;
  /** 任务完成提醒偏好 */
  notifications?: {
    badge?: boolean;
    system?: boolean;
    sound?: boolean;
  };
  /** 网络代理设置 */
  network?: {
    proxyEnabled?: boolean;
    proxyMode?: 'system' | 'custom';
    proxyUrl?: string;
    noProxy?: string;
  };
  /** 终端字体栈 */
  terminalFontFamily?: string;
};

export type Project = {
  id: string;
  name: string;
  winPath: string;
  wslPath: string;
  hasDotCodex: boolean;
  createdAt: number;
  lastOpenedAt?: number;
};

export type HistorySummary = {
  providerId: "codex" | "claude" | "gemini";
  id: string;
  title: string;
  date: number | string; // 主进程用 mtimeMs（number），前端常转成 ISO string
  filePath: string;
  rawDate?: string;
  preview?: string;
  resumeMode?: 'modern' | 'legacy' | 'unknown';
  resumeId?: string;
  runtimeShell?: 'wsl' | 'windows' | 'unknown';
};

export type MessageContent = { type: string; text: string };
export type HistoryMessage = { role: string; content: MessageContent[] };

// ---- Host API 声明 ----
export interface PtyAPI {
  openWSLConsole(args: { terminal?: 'wsl' | 'windows' | 'pwsh'; distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string }): Promise<{ id: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  onData(id: string, handler: (data: string) => void): () => void;
  onExit?: (handler: (payload: { id: string; exitCode?: number }) => void) => () => void;
  // 可选：为 ConPTY/xterm 重排期间做握手控制
  pause?: (id: string) => void;
  resume?: (id: string) => void;
  clear?: (id: string) => void;
}

export interface ProjectsAPI {
  scan(args?: { roots?: string[] }): Promise<{ ok: boolean; projects?: Project[]; error?: string }>;
  add(args: { winPath: string }): Promise<{ ok: boolean; project?: Project | null; error?: string }>;
  touch(id: string): void;
}

export interface HistoryAPI {
  list(args: { projectWslPath?: string; projectWinPath?: string; limit?: number; offset?: number; historyRoot?: string }): Promise<{ ok: boolean; sessions?: HistorySummary[]; error?: string }>;
  read(args: { filePath: string; providerId?: "codex" | "claude" | "gemini" }): Promise<{ id: string; title: string; date: number; messages: HistoryMessage[]; skippedLines: number; providerId?: "codex" | "claude" | "gemini" }>;
  findEmptySessions(): Promise<{ ok: boolean; candidates?: Array<{ id: string; title: string; rawDate?: string; date: number; filePath: string; sizeKB?: number }>; error?: string }>;
  trash(args: { filePath: string }): Promise<{ ok: true; notFound?: boolean } | { ok: false; error: string }>;
  trashMany(args: { filePaths: string[] }): Promise<{ ok: boolean; results?: Array<{ filePath: string; ok: boolean; notFound?: boolean; error?: string }>; summary?: { ok: number; notFound: number; failed: number }; error?: string }>;
  onIndexAdd?(handler: (payload: { items: HistorySummary[] }) => void): () => void;
  onIndexUpdate?(handler: (payload: { item: HistorySummary }) => void): () => void;
  onIndexRemove?(handler: (payload: { filePath: string }) => void): () => void;
  onIndexInvalidate?(handler: (payload: { reason?: string }) => void): () => void;
}

export interface SettingsAPI {
  get(): Promise<AppSettings>;
  update(partial: Partial<AppSettings>): Promise<AppSettings>;
  codexRoots(): Promise<string[]>;
  sessionRoots?(args: { providerId: "codex" | "claude" | "gemini" }): Promise<string[]>;
}

export interface StorageAPI {
  getAppDataInfo(): Promise<{
    ok: boolean;
    path: string;
    totalBytes: number;
    dirCount: number;
    fileCount: number;
    collectedAt: number;
    error?: string;
  }>;
  clearAppData(args?: { preserveSettings?: boolean }): Promise<{
    ok: boolean;
    path: string;
    bytesBefore: number;
    bytesAfter: number;
    bytesFreed: number;
    removedEntries: number;
    skippedEntries: number;
    errors?: Array<{ name: string; message: string }>;
    error?: string;
    scheduled?: boolean;
    note?: string;
  }>;
  purgeAppDataAndQuit(): Promise<{
    ok: boolean;
    path: string;
    bytesBefore: number;
    bytesAfter: number;
    bytesFreed: number;
    removedEntries: number;
    skippedEntries: number;
    errors?: Array<{ name: string; message: string }>;
    error?: string;
    scheduled?: boolean;
    note?: string;
  }>;
}

export type CodexAccountInfo = {
  accountId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
};

export type CodexRateLimitWindow = {
  usedPercent: number | null;
  limitWindowSeconds: number | null;  // 原始字段（秒），UI 层转换为分钟/小时/天
  resetAfterSeconds: number | null;   // 原始字段，统一命名
};

export type CodexRateLimitSnapshot = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

export type ClaudeUsageWindow = {
  remainingPercent: number | null;
  usedPercent: number | null;
  resetText?: string | null;
};

export type ClaudeUsageSnapshot = {
  providerId: "claude";
  source: "ccline-cache" | "tmux-capture";
  collectedAt: number;
  cachedAt?: number | null;
  resetAt?: number | null;
  windows: {
    fiveHour: ClaudeUsageWindow;
    sevenDay: ClaudeUsageWindow;
    weekOpus?: ClaudeUsageWindow | null;
  };
};

export type GeminiQuotaBucket = {
  remainingAmount?: string;
  remainingFraction?: number;
  resetTime?: string;
  tokenType?: string;
  modelId?: string;
};

export type GeminiQuotaSnapshot = {
  providerId: "gemini";
  collectedAt: number;
  projectId?: string | null;
  tierId?: string | null;
  buckets: GeminiQuotaBucket[];
};

export interface CodexAPI {
  getAccountInfo(): Promise<{ ok: boolean; info?: CodexAccountInfo; error?: string }>;
  getRateLimit(): Promise<{ ok: boolean; snapshot?: CodexRateLimitSnapshot; error?: string }>;
}

export interface ClaudeAPI {
  getUsage(): Promise<{ ok: boolean; snapshot?: ClaudeUsageSnapshot; error?: string }>;
}

export interface GeminiAPI {
  getUsage(): Promise<{ ok: boolean; snapshot?: GeminiQuotaSnapshot; error?: string }>;
}

export interface NotificationsAPI {
  setBadgeCount(count: number): void;
  showAgentCompletion(payload: { tabId: string; tabName?: string; projectName?: string; preview?: string; title: string; body: string; appTitle?: string }): void;
  onFocusTab?(handler: (payload: { tabId: string }) => void): () => void;
}

export interface UtilsAPI {
  perfLog(text: string): Promise<{ ok: boolean; error?: string }>;
  getWindowsInfo(): Promise<{ ok: boolean; platform?: string; buildNumber?: number; backend?: string; conptyAvailable?: boolean; error?: string }>;
  copyText(text: string): Promise<{ ok: boolean; error?: string }>;
  readText(): Promise<{ ok: boolean; text?: string; error?: string }>;
  saveText(content: string, defaultPath?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  fetchJson(args: { url: string; timeoutMs?: number; headers?: Record<string, string> }): Promise<{ ok: boolean; status?: number; data?: any; error?: string; raw?: string }>;
  showInFolder(p: string): Promise<{ ok: boolean; openedDir?: string; error?: string }>;
  openPath(p: string): Promise<{ ok: boolean; error?: string }>;
  openExternalUrl(url: string): Promise<{ ok: boolean; error?: string }>;
  openExternalConsole(args: { terminal?: 'wsl' | 'windows' | 'pwsh'; wslPath?: string; winPath?: string; distro?: string; startupCmd?: string; title?: string }): Promise<{ ok: boolean; error?: string }>;
  // 兼容旧名
  openExternalWSLConsole?(args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }): Promise<{ ok: boolean; error?: string }>;
  pathExists(p: string, dirOnly?: boolean): Promise<{ ok: boolean; exists?: boolean; isDirectory?: boolean; isFile?: boolean; error?: string }>;
  chooseFolder(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  debugTermGet(): Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
  debugTermSet(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  /** 列出系统已安装字体名称（Windows）。其他平台返回空数组。 */
  listFonts(): Promise<string[]>;
  /** 列出系统字体详情：包含路径与是否等宽（基于字体表元数据判定）。 */
  listFontsDetailed(): Promise<Array<{ name: string; file?: string; monospace: boolean }>>;
  /** 检测系统是否安装 PowerShell 7（pwsh）。仅 Windows 返回可用性与路径。 */
  detectPwsh(): Promise<{ ok: boolean; available?: boolean; path?: string; error?: string }>;
}

// 仅声明渲染层使用到的最小 API（与 preload.ts 暴露保持一致）
export interface WslAPI {
  listDistros(): Promise<{ ok: boolean; distros: string[]; error?: string }>;
}

export interface FileIndexAPI {
  ensureIndex(args: { root: string; excludes?: string[] }): Promise<{ ok: boolean; total?: number; updatedAt?: number; error?: string }>;
  getAllCandidates(root: string): Promise<{ ok: boolean; items?: Array<{ rel: string; isDir: boolean }>; error?: string }>;
  setActiveRoots(roots: string[]): Promise<{ ok: boolean; closed?: number; remain?: number; trimmed?: number; error?: string }>;
  onChanged?: (handler: (payload: { root: string; reason?: string; adds?: { rel: string; isDir: boolean }[]; removes?: { rel: string; isDir: boolean }[] }) => void) => () => void;
}

export interface ImagesAPI {
  saveDataURL(args: { dataURL: string; projectWinRoot?: string; projectName?: string; ext?: string; prefix?: string }): Promise<{ ok: boolean; winPath?: string; wslPath?: string; fileName?: string; error?: string }>;
  clipboardHasImage(): Promise<{ ok: boolean; has?: boolean; error?: string }>;
  saveFromClipboard(args: { projectWinRoot?: string; projectName?: string; prefix?: string }): Promise<{ ok: boolean; winPath?: string; wslPath?: string; fileName?: string; error?: string }>;
  trash(args: { winPath: string }): Promise<{ ok: boolean; error?: string }>;
}

export interface AppAPI {
  getVersion(): Promise<string>;
  getPaths(): Promise<{ licensePath?: string; noticePath?: string }>;
  /** 仅 Windows：设置原生标题栏主题（light/dark） */
  setTitleBarTheme?(theme: { mode: 'light' | 'dark'; source?: ThemeSetting } | 'light' | 'dark'): Promise<{ ok: boolean; error?: string }>;
}

export interface EnvAPI {
  getMeta(): Promise<{ ok: boolean; isDev?: boolean; devServerUrl?: string | null; protocol?: string; error?: string }>;
}

export interface I18nAPI {
  getLocale(): Promise<{ ok: boolean; locale?: string; error?: string }>;
  setLocale(locale: string): Promise<{ ok: boolean; locale?: string; error?: string }>;
  onLocaleChanged?(handler: (payload: { locale: string }) => void): () => void;
  userLocales?: {
    dir(): Promise<{ ok: boolean; dir?: string; error?: string }>;
    list(): Promise<{ ok: boolean; languages?: string[]; error?: string }>;
    read(lng: string, ns: string): Promise<{ ok: boolean; data?: any; error?: string }>;
  }
}

declare global {
  interface Window {
    host: {
      app: AppAPI;
      env: EnvAPI;
      pty: PtyAPI;
      projects: ProjectsAPI;
      history: HistoryAPI;
      settings: SettingsAPI;
      storage: StorageAPI;
      utils: UtilsAPI;
      i18n: I18nAPI;
      codex: CodexAPI;
      claude: ClaudeAPI;
      gemini: GeminiAPI;
      notifications: NotificationsAPI;
      wsl?: WslAPI;
      fileIndex?: FileIndexAPI;
      images?: ImagesAPI;
      debug?: {
        get(): Promise<any>;
        update(partial: any): Promise<any>;
        reset?(): Promise<any>;
        onChanged?(handler: () => void): () => void;
      };
    };
  }
}
