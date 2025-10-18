// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export {}; // make this a module

// 与主进程约定的类型（仅做声明，不引入运行时依赖）
export type AppSettings = {
  terminal?: 'wsl' | 'windows';
  distro: string;
  codexCmd: string;
  historyRoot: string;
  sendMode?: 'write_only' | 'write_and_enter';
  locale?: string;
  projectPathStyle?: 'absolute' | 'relative';
  /** 任务完成提醒偏好 */
  notifications?: {
    badge?: boolean;
    system?: boolean;
    sound?: boolean;
  };
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
  openWSLConsole(args: { distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string }): Promise<{ id: string }>;
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
  read(args: { filePath: string }): Promise<{ id: string; title: string; date: number; messages: HistoryMessage[]; skippedLines: number }>;
  findEmptySessions(): Promise<{ ok: boolean; candidates?: Array<{ id: string; title: string; rawDate?: string; date: number; filePath: string; sizeKB?: number }>; error?: string }>;
  trash(args: { filePath: string }): Promise<{ ok: true; notFound?: boolean } | { ok: false; error: string }>;
  trashMany(args: { filePaths: string[] }): Promise<{ ok: boolean; results?: Array<{ filePath: string; ok: boolean; notFound?: boolean; error?: string }>; summary?: { ok: number; notFound: number; failed: number }; error?: string }>;
  onIndexAdd?(handler: (payload: { items: HistorySummary[] }) => void): () => void;
  onIndexUpdate?(handler: (payload: { item: HistorySummary }) => void): () => void;
  onIndexRemove?(handler: (payload: { filePath: string }) => void): () => void;
}

export interface SettingsAPI {
  get(): Promise<AppSettings>;
  update(partial: Partial<AppSettings>): Promise<AppSettings>;
  codexRoots(): Promise<string[]>;
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
  windowMinutes: number | null;
  resetsInSeconds: number | null;
};

export type CodexRateLimitSnapshot = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

export interface CodexAPI {
  getAccountInfo(): Promise<{ ok: boolean; info?: CodexAccountInfo; error?: string }>;
  getRateLimit(): Promise<{ ok: boolean; snapshot?: CodexRateLimitSnapshot; error?: string }>;
}

export interface NotificationsAPI {
  setBadgeCount(count: number): void;
  showAgentCompletion(payload: { tabId: string; tabName?: string; projectName?: string; preview?: string; title: string; body: string; appTitle?: string }): void;
  onFocusTab?(handler: (payload: { tabId: string }) => void): () => void;
}

export interface UtilsAPI {
  perfLog(text: string): Promise<{ ok: boolean; error?: string }>;
  copyText(text: string): Promise<{ ok: boolean; error?: string }>;
  readText(): Promise<{ ok: boolean; text?: string; error?: string }>;
  saveText(content: string, defaultPath?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  fetchJson(args: { url: string; timeoutMs?: number; headers?: Record<string, string> }): Promise<{ ok: boolean; status?: number; data?: any; error?: string; raw?: string }>;
  showInFolder(p: string): Promise<{ ok: boolean; openedDir?: string; error?: string }>;
  openPath(p: string): Promise<{ ok: boolean; error?: string }>;
  openExternalUrl(url: string): Promise<{ ok: boolean; error?: string }>;
  openExternalConsole(args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }): Promise<{ ok: boolean; error?: string }>;
  // 兼容旧名
  openExternalWSLConsole?(args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }): Promise<{ ok: boolean; error?: string }>;
  pathExists(p: string, dirOnly?: boolean): Promise<{ ok: boolean; exists?: boolean; error?: string }>;
  chooseFolder(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  debugTermGet(): Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
  debugTermSet(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
}

export interface AppAPI {
  getVersion(): Promise<string>;
  getPaths(): Promise<{ licensePath?: string; noticePath?: string }>;
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
      pty: PtyAPI;
      projects: ProjectsAPI;
      history: HistoryAPI;
      settings: SettingsAPI;
      storage: StorageAPI;
      utils: UtilsAPI;
      i18n: I18nAPI;
      codex: CodexAPI;
      notifications: NotificationsAPI;
    };
  }
}
