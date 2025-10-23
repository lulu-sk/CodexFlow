// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu, screen, session } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher, Agent } from 'undici';
import { PTYManager, setTermDebug } from "./pty.js";
import projects, { IMPLEMENTATION_NAME as PROJECTS_IMPL } from "./projects/index";
import history from "./history";
import { startHistoryIndexer, getIndexedSummaries, getIndexedDetails, getLastIndexerRoots, stopHistoryIndexer } from "./indexer";
import { getSessionsRootsFastAsync } from "./wsl";
import { perfLogger } from "./log";
import settings, { ensureSettingsAutodetect } from "./settings";
import i18n from "./i18n";
import wsl from "./wsl";
import fileIndex from "./fileIndex";
import images from "./images";
import { installInputContextMenu } from "./contextMenu";
import { CodexBridge, type CodexBridgeOptions } from "./codex/bridge";
import { ensureAllCodexNotifications } from "./codex/config";
import storage from "./storage";
import { registerNotificationIPC } from "./notifications";

// 使用 CommonJS 编译输出时，运行时环境会提供 `__dirname`，直接使用即可

let mainWindow: BrowserWindow | null = null;
const DIAG = String(process.env.CODEX_DIAG_LOG || '').trim() === '1';
const APP_USER_MODEL_ID = 'com.codexflow.app';
const DEV_APP_USER_MODEL_ID = 'com.codexflow.app.dev';
const PROTOCOL_SCHEME = 'codexflow';
const ptyManager = new PTYManager(() => mainWindow);
// 会话期粘贴图片（保存后的 Windows 路径），用于退出时统一清理
const sessionPastedImages = new Set<string>();
const codexBridges = new Map<string, CodexBridge>();

function disposeAllPtys() {
  try { ptyManager.disposeAll(); } catch (e) { /* noop */ }
}

function disposeCodexBridges() {
  if (codexBridges.size === 0) return;
  for (const [key, bridge] of codexBridges.entries()) {
    try {
      bridge.dispose();
    } catch (e) {
      if (DIAG) {
        try { perfLogger.log(`[codex] dispose failed (${key}): ${String(e)}`); } catch {}
      }
    } finally {
      codexBridges.delete(key);
    }
  }
}

async function cleanupPastedImages() {
  try {
    if (sessionPastedImages.size === 0) return;
    const toTrash = Array.from(sessionPastedImages);
    sessionPastedImages.clear();
    for (const p of toTrash) {
      try {
        if (fs.existsSync(p)) {
          // 彻底删除粘贴的临时图片（无回收站回退）
          try { await fsp.rm(p, { force: true }); } catch {}
        }
      } catch {}
    }
  } catch {}
}

function resolveCodexBridgeTarget(): { key: string; options: CodexBridgeOptions } {
  const cfg = settings.getSettings();
  const terminal = cfg.terminal ?? "wsl";
  if (terminal === "wsl" && process.platform === "win32") {
    const distro = cfg.distro ? String(cfg.distro) : undefined;
    const key = `wsl:${distro ?? ""}`;
    return { key, options: { mode: "wsl", wslDistro: distro } };
  }
  return { key: "native", options: { mode: "native" } };
}

function ensureCodexBridge(): CodexBridge {
  const { key, options } = resolveCodexBridgeTarget();
  let bridge = codexBridges.get(key);
  if (!bridge) {
    bridge = new CodexBridge(options);
    codexBridges.set(key, bridge);
  }
  return bridge;
}

// 统一配置/更新全局代理（支持：自定义/系统代理；并同步给 CLI 及 WSL 环境变量）
let appliedProxySig = "";
function redactProxy(uri: string): string {
  try {
    const u = new URL(uri);
    const auth = u.username || u.password ? "***@" : "";
    return `${u.protocol}//${auth}${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return uri.replace(/\/\/([^@]+)@/, "//***@");
  }
}

function chooseFromElectronProxyString(spec: string): string | null {
  // 参考 Chromium 语法：
  // 返回形如 "DIRECT"、"PROXY host:port; DIRECT"、"SOCKS5 host:port; PROXY ..."
  const parts = String(spec || "").split(";").map((s) => s.trim().toUpperCase());
  // 优先 SOCKS5/SOCKS
  for (const p of parts) {
    const m = p.match(/^SOCKS5\s+([^;\s]+)$/) || p.match(/^SOCKS\s+([^;\s]+)$/);
    if (m && m[1]) return `socks5://${m[1]}`;
  }
  // 再尝试 HTTP 代理（PROXY）
  for (const p of parts) {
    const m = p.match(/^PROXY\s+([^;\s]+)$/);
    if (m && m[1]) return `http://${m[1]}`;
  }
  return null;
}

async function detectSystemProxyUrl(): Promise<string | null> {
  try {
    const s = session.defaultSession;
    if (!s) return null;
    const spec = await s.resolveProxy('https://chatgpt.com');
    const uri = chooseFromElectronProxyString(spec);
    return uri;
  } catch {
    return null;
  }
}

async function configureOrUpdateProxy(): Promise<void> {
  try {
    const cfg = settings.getSettings() as any;
    const net = (cfg && cfg.network) ? cfg.network : {};
    let uri: string | null = null;
    let noProxy = String(net.noProxy || process.env.NO_PROXY || '').trim();

    if (net.proxyEnabled === false) {
      // 显式关闭代理
      setGlobalDispatcher(new Agent());
      delete (process as any).env.CODEXFLOW_PROXY;
      delete (process as any).env.HTTPS_PROXY;
      delete (process as any).env.HTTP_PROXY;
      if (noProxy) (process as any).env.NO_PROXY = noProxy; else delete (process as any).env.NO_PROXY;
      const sig = `off|${noProxy}`;
      if (sig !== appliedProxySig) {
        appliedProxySig = sig;
        try { perfLogger.log(`[codex] Proxy disabled`); } catch {}
      }
      return;
    }

    const mode = (net.proxyMode as 'system' | 'custom') || 'system';
    if (mode === 'custom') {
      const raw = String(net.proxyUrl || '').trim();
      if (raw) {
        try { uri = new URL(raw).toString(); } catch { uri = raw; }
      }
    }
    if (!uri) {
      // 环境变量回退
      const envRaw = (process.env.CODEXFLOW_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
      if (envRaw) uri = envRaw;
    }
    if (!uri && mode === 'system') {
      uri = await detectSystemProxyUrl();
    }

    if (!uri) {
      // 未检测到代理：使用直连
      setGlobalDispatcher(new Agent());
      const sig = `direct|${noProxy}`;
      if (sig !== appliedProxySig) {
        appliedProxySig = sig;
        try { perfLogger.log(`[codex] Proxy: DIRECT`); } catch {}
      }
      return;
    }

    // 应用代理并同步环境变量（供子进程与 WSL 使用）
    setGlobalDispatcher(new ProxyAgent(uri));
    (process as any).env.CODEXFLOW_PROXY = uri;
    (process as any).env.HTTPS_PROXY = uri;
    (process as any).env.HTTP_PROXY = uri;
    if (noProxy) (process as any).env.NO_PROXY = noProxy; else delete (process as any).env.NO_PROXY;

    const sig = `${uri}|${noProxy}`;
    if (sig !== appliedProxySig) {
      appliedProxySig = sig;
      try { perfLogger.log(`[codex] Using proxy: ${redactProxy(uri)}${noProxy ? ` (NO_PROXY=${noProxy})` : ''}`); } catch {}
    }
  } catch (err) {
    try { perfLogger.log(`[codex] Proxy setup failed: ${err instanceof Error ? err.message : String(err)}`); } catch {}
  }
}

function rectsOverlap(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  const horizontal = a.x < b.x + b.width && a.x + a.width > b.x;
  const vertical = a.y < b.y + b.height && a.y + a.height > b.y;
  return horizontal && vertical;
}

function ensureDetachedDevtoolsInView(): void {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const devtools = wc.devToolsWebContents;
  if (!devtools) return;
  const devtoolsWindow = BrowserWindow.fromWebContents(devtools);
  if (!devtoolsWindow || devtoolsWindow === mainWindow) return;

  const currentBounds = devtoolsWindow.getBounds();
  const displays = screen.getAllDisplays();
  const visible = displays.some((display) => rectsOverlap(currentBounds, display.workArea));

  if (!visible) {
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(Math.max(currentBounds.width || 900, 600), workArea.width);
    const height = Math.min(Math.max(currentBounds.height || 700, 480), workArea.height);
    const x = workArea.x + Math.floor((workArea.width - width) / 2);
    const y = workArea.y + Math.floor((workArea.height - height) / 2);
    devtoolsWindow.setBounds({ x, y, width, height });
  }

  devtoolsWindow.show();
  devtoolsWindow.focus();
}

function resolveAppIcon(): string | undefined {
  try {
    const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    if (app.isPackaged) {
      const packagedIcon = path.join(process.resourcesPath, iconName);
      if (fs.existsSync(packagedIcon)) return packagedIcon;
    } else {
      const devIcon = path.join(process.cwd(), 'build', iconName);
      if (fs.existsSync(devIcon)) return devIcon;
    }
    const packagedFallback = path.join(process.resourcesPath, 'icon.png');
    if (app.isPackaged && fs.existsSync(packagedFallback)) return packagedFallback;
    const devFallback = path.join(process.cwd(), 'build', 'icon.png');
    if (!app.isPackaged && fs.existsSync(devFallback)) return devFallback;
  } catch {}
  return undefined;
}

function resolveRendererEntry(): string {
  const appPath = app.getAppPath();
  const dirBasedHtml = path.join(__dirname, '..', '..', 'web', 'dist', 'index.html');
  const packagedHtml = path.join(appPath, 'web', 'dist', 'index.html');
  const unpackedHtml = path.join(process.resourcesPath, 'app.asar.unpacked', 'web', 'dist', 'index.html');
  const resourcesHtml = path.join(process.resourcesPath, 'web', 'dist', 'index.html');
  const projectHtml = path.join(process.cwd(), 'web', 'dist', 'index.html');
  const candidates = app.isPackaged
    ? [packagedHtml, dirBasedHtml, unpackedHtml, resourcesHtml, projectHtml]
    : [projectHtml, dirBasedHtml, packagedHtml, resourcesHtml];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  // 缺省返回候选列表首项，即便缺失也能让 loadFile 给出明确错误
  return candidates[0] || projectHtml;
}

function ensureWindowsDevShortcut(appUserModelId: string, iconPath?: string) {
  try {
    const startMenuRoot = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcutDir = path.join(startMenuRoot, 'CodexFlow');
    const shortcutPath = path.join(shortcutDir, 'CodexFlow Dev.lnk');
    try { fs.mkdirSync(shortcutDir, { recursive: true }); } catch {}
    const target = process.execPath;
    const cwd = path.dirname(target);
    let current: Electron.ShortcutDetails | null = null;
    try { current = shell.readShortcutLink(shortcutPath); } catch {}
    const shortcutDetails: Electron.ShortcutDetails = {
      appUserModelId,
      target,
      cwd,
      description: 'CodexFlow (Dev)',
    };
    if (iconPath) {
      shortcutDetails.icon = iconPath;
      shortcutDetails.iconIndex = 0;
    }
    const needsUpdate = !current
      || current.target !== shortcutDetails.target
      || current.appUserModelId !== shortcutDetails.appUserModelId
      || (!!shortcutDetails.icon && current.icon !== shortcutDetails.icon);
    if (needsUpdate) {
      const mode: 'create' | 'update' | 'replace' = current ? 'update' : 'create';
      shell.writeShortcutLink(shortcutPath, mode, shortcutDetails);
      try { perfLogger.log(`[notifications] ensure dev shortcut mode=${mode} path=${shortcutPath}`); } catch {}
    }
  } catch (error) {
    try { perfLogger.log(`[notifications] ensure dev shortcut failed: ${String(error)}`); } catch {}
  }
}

function ensureWindowsUserShortcut(appUserModelId: string, iconPath?: string) {
  try {
    const startMenuRoot = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcutDir = path.join(startMenuRoot, 'CodexFlow');
    const shortcutPath = path.join(shortcutDir, 'CodexFlow.lnk');
    try { fs.mkdirSync(shortcutDir, { recursive: true }); } catch {}
    const target = process.execPath;
    const cwd = path.dirname(target);
    let current: Electron.ShortcutDetails | null = null;
    try { current = shell.readShortcutLink(shortcutPath); } catch {}
    const shortcutDetails: Electron.ShortcutDetails = {
      appUserModelId,
      target,
      cwd,
      description: 'CodexFlow',
    };
    if (iconPath) {
      shortcutDetails.icon = iconPath;
      shortcutDetails.iconIndex = 0;
    }
    const needsUpdate = !current
      || current.target !== shortcutDetails.target
      || current.appUserModelId !== shortcutDetails.appUserModelId
      || (!!shortcutDetails.icon && current.icon !== shortcutDetails.icon);
    if (needsUpdate) {
      const mode: 'create' | 'update' | 'replace' = current ? 'update' : 'create';
      shell.writeShortcutLink(shortcutPath, mode, shortcutDetails);
      try { perfLogger.log(`[notifications] ensure user shortcut mode=${mode} path=${shortcutPath}`); } catch {}
    }
  } catch (error) {
    try { perfLogger.log(`[notifications] ensure user shortcut failed: ${String(error)}`); } catch {}
  }
}

function setupWindowsNotifications(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const appUserModelId = app.isPackaged ? APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
  try { app.setAppUserModelId(appUserModelId); } catch (error) {
    try { perfLogger.log(`[notifications] setAppUserModelId failed: ${String(error)}`); } catch {}
  }
  const iconPath = resolveAppIcon();
  if (app.isPackaged) ensureWindowsUserShortcut(appUserModelId, iconPath);
  else ensureWindowsDevShortcut(appUserModelId, iconPath);
  return appUserModelId;
}

function registerProtocol(): void {
  try {
    let registered = false;
    if (app.isPackaged) {
      registered = app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
    } else {
      const extra = (() => {
        try {
          const target = process.argv[1];
          if (!target) return [];
          return [path.resolve(target)];
        } catch { return []; }
      })();
      registered = app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, extra);
    }
    // 与通知模块的 toastXml 保持同一协议，避免后续改动导致 Windows Action Center 无法激活
    try { perfLogger.log(`[notifications] protocol ${PROTOCOL_SCHEME} registered=${registered}`); } catch {}
  } catch (error) {
    try { perfLogger.log(`[notifications] protocol register failed: ${String(error)}`); } catch {}
  }
}

function extractProtocolUrl(argv: string[] | readonly string[] | undefined | null): string | null {
  try {
    if (!argv) return null;
    const prefix = `${PROTOCOL_SCHEME.toLowerCase()}://`;
    for (const arg of argv) {
      if (typeof arg !== 'string') continue;
      if (arg.toLowerCase().startsWith(prefix)) return arg;
    }
  } catch {}
  return null;
}

function focusTabFromProtocol(rawUrl?: string | null) {
  if (!rawUrl) return;
  try {
    const parsed = new URL(rawUrl);
    const intent = parsed.hostname || parsed.pathname.replace(/^\//, '');
    if (intent !== 'focus-tab') return;
    const tabId = parsed.searchParams.get('tabId') ?? parsed.searchParams.get('tab') ?? parsed.searchParams.get('id');
    if (!tabId) return;
    const handleWindow = (target: BrowserWindow) => {
      if (target.isMinimized()) {
        try { target.restore(); } catch {}
      }
      try { target.show(); target.focus(); } catch {}
      const wc = target.webContents;
      const dispatch = () => {
        try { perfLogger.log(`[notifications] protocol focus tabId=${tabId}`); } catch {}
        try { wc.send('notifications:focus-tab', { tabId }); } catch {}
      };
      if (wc.isDestroyed()) return;
      if (wc.isLoading()) wc.once('did-finish-load', dispatch);
      else dispatch();
    };
    if (mainWindow) {
      handleWindow(mainWindow);
      return;
    }
    app.once('browser-window-created', (_event, win) => {
      if (!win) return;
      const deliver = () => handleWindow(win);
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) return;
      if (wc.isLoading()) wc.once('did-finish-load', deliver);
      else deliver();
    });
  } catch (error) {
    try { perfLogger.log(`[notifications] protocol focus failed: ${String(error)}`); } catch {}
  }
}


function createWindow() {
  const windowIcon = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: windowIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 显式允许开发者工具（默认即为 true，此处明确写出以避免歧义）
      devTools: true
    },
    show: true
  });

  mainWindow.webContents.on('devtools-opened', () => {
    setTimeout(() => { try { ensureDetachedDevtoolsInView(); } catch {} }, 0);
  });

  // 安装输入框右键菜单（撤销/重做/剪切/复制/粘贴/全选，支持多语言）
  try { installInputContextMenu(mainWindow.webContents); } catch {}

  const devUrl = process.env.DEV_SERVER_URL;
  if (DIAG) { try { perfLogger.log(`[WIN] create BrowserWindow devUrl=${devUrl || ''}`); } catch {} }
  if (devUrl && /^https?:/i.test(devUrl)) {
    if (DIAG) { try { perfLogger.log(`[WIN] loadURL ${devUrl}`); } catch {} }
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const entryFile = resolveRendererEntry();
    if (DIAG) { try { perfLogger.log(`[WIN] loadFile ${entryFile}`); } catch {} }
    mainWindow.loadFile(entryFile);
    // 支持通过环境变量强制打开 DevTools（无论是否走本地文件或打包产物）
    try {
      const forceDevtools = String(process.env.CODEX_OPEN_DEVTOOLS || '').trim() === '1';
      if (forceDevtools) mainWindow.webContents.openDevTools({ mode: 'detach' });
    } catch {}
  }

  // 渲染进程诊断钩子
  if (DIAG) try {
    const wc = mainWindow.webContents;
    wc.on('did-start-loading', () => { try { perfLogger.log('[WC] did-start-loading'); } catch {} });
    wc.on('dom-ready', () => { try { perfLogger.log('[WC] dom-ready'); } catch {} });
    wc.on('did-finish-load', () => { try { perfLogger.log('[WC] did-finish-load'); } catch {} });
    wc.on('did-frame-finish-load', (_e, isMain) => { try { perfLogger.log(`[WC] did-frame-finish-load main=${isMain}`); } catch {} });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      try { perfLogger.log(`[WC] did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`); } catch {}
    });
    wc.on('did-navigate', (_e, url) => { try { perfLogger.log(`[WC] did-navigate url=${url}`); } catch {} });
    wc.on('did-navigate-in-page', (_e, url) => { try { perfLogger.log(`[WC] did-navigate-in-page url=${url}`); } catch {} });
    wc.on('render-process-gone', (_e, details) => { try { perfLogger.log(`[WC] render-process-gone reason=${(details as any)?.reason} exitCode=${(details as any)?.exitCode}`); } catch {} });
    wc.on('unresponsive', () => { try { perfLogger.log('[WC] unresponsive'); } catch {} });
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      try { perfLogger.log(`[WC.console] level=${level} ${sourceId}:${line} ${message}`); } catch {}
    });
  } catch {}

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = extractProtocolUrl(argv as any);
    if (url) {
      focusTabFromProtocol(url);
      return;
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 统一配置/更新全局代理（支持 Codex、fetch 等所有 undici 请求）
    try { await configureOrUpdateProxy(); } catch {}
    const appUserModelId = setupWindowsNotifications();
    registerProtocol();
    try { perfLogger.log(`[BOOT] Using projects implementation: ${PROJECTS_IMPL}`); } catch {}
    if (DIAG) { try { perfLogger.log(`[BOOT] userData=${app.getPath('userData')}`); } catch {} }
    try { await ensureSettingsAutodetect(); } catch {}
    try { await ensureAllCodexNotifications(); } catch {}
    try { i18n.registerI18nIPC(); } catch {}
    if (DIAG) { try { perfLogger.log(`[BOOT] Locale: ${i18n.getCurrentLocale?.()}`); } catch {} }
    // 构建应用菜单（包含 Toggle Developer Tools）
    try { setupAppMenu(); } catch {}
    try { registerNotificationIPC(() => mainWindow, { appUserModelId, protocolScheme: PROTOCOL_SCHEME }); } catch {}
    try { createWindow(); } catch (e) { if (DIAG) { try { perfLogger.log(`[BOOT] createWindow error: ${String(e)}`); } catch {} } }
    focusTabFromProtocol(extractProtocolUrl(process.argv));
    // 启动时静默检查更新由渲染进程完成（仅提示，不下载）
    try {
      // 读取环境变量作为主进程 PTY 日志默认值（1 开启，其它关闭）
      setTermDebug(String(process.env.CODEX_TERM_DEBUG || '').trim() === '1');
    } catch {}
    // 启动历史索引器：后台并发解析、缓存、监听变更
    try { await startHistoryIndexer(() => mainWindow); } catch (e) { console.warn('indexer start failed', e); }
    // 启动后立刻触发一次 UI 强制刷新，确保首次 ready 后显示索引内容
    try { mainWindow?.webContents.send('history:index:add', { items: [] }); } catch {}
  });

  const tryStopIndexer = () => {
    try { stopHistoryIndexer().catch(() => {}); } catch {}
  };

  app.on('before-quit', () => {
    disposeAllPtys();
    cleanupPastedImages().catch(() => {});
    disposeCodexBridges();
    tryStopIndexer();
  });

  app.on('will-quit', () => {
    disposeAllPtys();
    cleanupPastedImages().catch(() => {});
    disposeCodexBridges();
    tryStopIndexer();
  });

  // Also hook process-level events so that when Node receives termination signals we attempt cleanup.
  process.on('exit', () => { disposeAllPtys(); disposeCodexBridges(); tryStopIndexer(); });
  process.on('SIGINT', () => { disposeAllPtys(); cleanupPastedImages().catch(() => {}); disposeCodexBridges(); tryStopIndexer(); process.exit(0); });
  process.on('SIGTERM', () => { disposeAllPtys(); cleanupPastedImages().catch(() => {}); disposeCodexBridges(); tryStopIndexer(); process.exit(0); });
  process.on('uncaughtException', (err) => {
    try { console.error('uncaughtException', err); } catch {}
    if (DIAG) { try { perfLogger.log(`[PROC] uncaughtException ${String((err as any)?.stack || err)}`); } catch {} }
    disposeAllPtys();
    disposeCodexBridges();
    // rethrow to allow default behavior after cleanup
    try { throw err; } catch {}
  });
  if (DIAG) process.on('unhandledRejection', (reason: any) => {
    try { perfLogger.log(`[PROC] unhandledRejection ${String((reason as any)?.stack || reason)}`); } catch {}
  });

  app.on('window-all-closed', () => {
    // On Windows & Linux, quit on all closed
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// 应用菜单：显式提供 View -> Toggle Developer Tools，避免依赖平台默认菜单
function setupAppMenu() {
  try {
    const isMac = process.platform === 'darwin';
    const template: Electron.MenuItemConstructorOptions[] = [
      // macOS 标准应用菜单
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
    ];
    // 打包版 Windows/Linux 不保留菜单栏；开发期或 macOS 仍保留调试入口
    if (!app.isPackaged || isMac) {
      template.push(
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { type: 'separator' },
            { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'close' },
          ],
        },
        {
          label: 'Help',
          submenu: [
            {
              label: 'Open Perf Log Folder',
              click: () => {
                try { shell.showItemInFolder(path.join(app.getPath('userData'), 'perf.log')); } catch {}
              },
            },
          ],
        },
      );
    }
    if (template.length === 0) {
      Menu.setApplicationMenu(null);
    } else {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }
  } catch {}
}

// -------- IPC: PTY bridge (I/O only) --------
ipcMain.handle('pty:open', async (_event, args: {
  distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string;
}) => {
  const id = ptyManager.openWSLConsole({
    distro: args?.distro,
    wslPath: args?.wslPath,
    winPath: args?.winPath,
    cols: args?.cols ?? 80,
    rows: args?.rows ?? 24,
    startupCmd: args?.startupCmd ?? ''
  });
  return { id };
});

ipcMain.on('pty:write', (_e, { id, data }: { id: string; data: string }) => {
  ptyManager.write(id, data);
});

ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  ptyManager.resize(id, cols, rows);
});

ipcMain.on('pty:close', (_e, { id }: { id: string }) => {
  ptyManager.close(id);
});

// 可选：在 resize 期间暂停/恢复数据流，以及与 ConPTY 同步清屏
ipcMain.on('pty:pause', (_e, { id }: { id: string }) => {
  try { ptyManager.pause(id); } catch {}
});
ipcMain.on('pty:resume', (_e, { id }: { id: string }) => {
  try { ptyManager.resume(id); } catch {}
});
ipcMain.on('pty:clear', (_e, { id }: { id: string }) => {
  try { ptyManager.clear(id); } catch {}
});

// File Index API（Windows 侧枚举，结果缓存于内存+磁盘）
ipcMain.handle('fileIndex.ensure', async (_e, { root, excludes }: { root: string; excludes?: string[] }) => {
  try {
    const res = await fileIndex.ensureIndex({ root, excludes });
    return { ok: true, total: res.total, updatedAt: res.updatedAt };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// 打开外部控制台（根据设置选择 WSL 或 Windows 终端）
ipcMain.handle('utils.openExternalConsole', async (_e, args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }) => {
  try {
    const platform = process.platform;
    const cfg = settings.getSettings();
    const terminal = cfg.terminal || 'wsl';
    const startupCmd = String(args?.startupCmd || cfg.codexCmd || 'codex');
    const requestedDistro = String(args?.distro || cfg.distro || 'Ubuntu-24.04');

    if (platform === 'win32' && terminal === 'windows') {
      // 计算工作目录：优先使用 winPath，其次从 wslPath 推导
      let cwd = String(args?.winPath || '').trim();
      const wslPathRaw = String(args?.wslPath || '').trim();
      if (!cwd && wslPathRaw) {
        const m = wslPathRaw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
        if (m) cwd = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
        if (!cwd) { try { cwd = wsl.wslToUNC(wslPathRaw, requestedDistro); } catch {} }
      }
      if (!cwd) { try { cwd = require('node:os').homedir(); } catch { cwd = process.cwd(); } }

      // 优先 Windows Terminal
      const trySpawn = (file: string, argv: string[]): Promise<boolean> => new Promise((resolve) => {
        try { const child = spawn(file, argv, { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => resolve(false)); child.unref(); resolve(true); } catch { resolve(false); }
      });
      // PowerShell 字符串经常包含引号与分号；为彻底避免转义问题，改用 -EncodedCommand（UTF-16LE -> Base64）
      const toPsEncoded = (s: string) => Buffer.from(s, 'utf16le').toString('base64');
      // 使用 Windows Terminal：指定起始目录，由 WT 负责切换目录；PowerShell 仅执行命令
      // 必须加入 `--`，将后续命令行完整传入新标签，而不被 wt 解析
      const wtArgs = ['-w', '0', 'new-tab', '--title', 'Codex', '--startingDirectory', cwd, '--', 'powershell', '-NoExit', '-NoProfile', '-EncodedCommand', toPsEncoded(startupCmd)];
      if (await trySpawn('wt.exe', wtArgs)) return { ok: true } as const;
      if (await trySpawn('WindowsTerminal.exe', wtArgs)) return { ok: true } as const;
      // 回退：cmd /c start 一个 PowerShell 窗口，使用 -EncodedCommand，先切换目录再执行
      const psScript = `Set-Location -Path \"${cwd.replace(/"/g, '\\"')}\"; ${startupCmd}`;
      const psEncoded = toPsEncoded(psScript);
      if (await trySpawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-NoProfile', '-EncodedCommand', psEncoded])) return { ok: true } as const;
      return { ok: false, error: 'failed to launch external Windows console' } as const;
    }

    // 否则：WSL 路径与逻辑
    let wslPath = String(args?.wslPath || '').trim();
    const winPath = String(args?.winPath || '').trim();
    if (!wslPath && winPath) { try { wslPath = wsl.winToWsl(winPath, requestedDistro); } catch {} }
    if (!wslPath) wslPath = '~';
    const esc = (s: string) => s.replace(/\"/g, '\\\"');
    const cdCmd = wslPath === '~' ? 'cd ~' : `cd \"${esc(wslPath)}\"`;
    const bashScript = `${cdCmd}; ${startupCmd}; exec bash`;

    if (platform === 'win32') {
      const hasDistro = (() => { try { return wsl.distroExists(requestedDistro); } catch { return false; } })();
      const distroArgv = hasDistro ? ['-d', requestedDistro] as string[] : [];
      const trySpawn = (file: string, argv: string[]): Promise<boolean> => new Promise((resolve) => {
        try { const child = spawn(file, argv, { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => resolve(false)); child.unref(); resolve(true); } catch { resolve(false); }
      });
      if (await trySpawn('cmd.exe', ['/c', 'start', '', 'wsl.exe', ...distroArgv, '--', 'bash', '-lic', bashScript])) return { ok: true } as const;
      const wtArgs = ['-w', '0', 'new-tab', '--title', 'Codex', '--', 'wsl.exe', ...distroArgv, '--', 'bash', '-lic', bashScript];
      if (await trySpawn('wt.exe', wtArgs)) return { ok: true } as const;
      if (await trySpawn('WindowsTerminal.exe', wtArgs)) return { ok: true } as const;
      const psArgListParts = [ ...(hasDistro ? [`'-d'`, `'${requestedDistro.replace(/'/g, "''")}'`] : []), `'--'`, `'bash'`, `'-lic'`, `'${bashScript.replace(/'/g, "''")}'` ];
      const psCmd = `Start-Process -FilePath wsl.exe -ArgumentList @(${psArgListParts.join(',')})`;
      if (await trySpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd])) return { ok: true } as const;
      return { ok: false, error: 'failed to launch external WSL console' } as const;
    }

    const candidates: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', bashScript] },
      { cmd: 'konsole', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'xterm', args: ['-e', 'bash', '-lc', bashScript] },
    ];
    for (const c of candidates) {
      try { const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', cwd: process.env.HOME }); child.on('error', () => {}); child.unref(); return { ok: true } as const; } catch {}
    }
    return { ok: false, error: 'no terminal available' } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});
ipcMain.handle('fileIndex.candidates', async (_e, { root }: { root: string }) => {
  try {
    const items = fileIndex.getAllCandidates(root);
    return { ok: true, items };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('fileIndex.activeRoots', async (_e, { roots }: { roots: string[] }) => {
  try {
    const list = Array.isArray(roots) ? roots.filter((x) => typeof x === 'string') : [];
    const res = (fileIndex as any).setActiveRoots ? (fileIndex as any).setActiveRoots(list) : { closed: 0, remain: 0 };
    return { ok: true, ...res };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Projects API
ipcMain.handle('projects.scan', async (_e, { roots }: { roots?: string[] }) => {
  try {
    const res = await projects.scanProjectsAsync(roots, true);
    return { ok: true, projects: res };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('projects.add', async (_e, { winPath }: { winPath: string }) => {
  try {
    const p = projects.addProjectByWinPath(winPath);
    return { ok: true, project: p };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.on('projects.touch', (_e, { id }: { id: string }) => {
  projects.touchProject(id);
});

// History API
ipcMain.handle('history.list', async (_e, args: { projectWslPath?: string; projectWinPath?: string; limit?: number; offset?: number; historyRoot?: string }) => {
  try {
    // 尝试优先使用索引器（不阻塞 UI）
    const canon = (p?: string): string => {
      if (!p) return '';
      try {
        let s = String(p).replace(/\\n/g, '').replace(/\\\\+/g, '\\').replace(/^"|"$/g, '');
        if (/^\\\\wsl\.localhost\\/i.test(s)) {
          // UNC -> WSL
          const info = require('./wsl').uncToWsl(s);
          if (info) return info.wslPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        }
        const m = s.match(/^([a-zA-Z]):\\(.*)$/);
        if (m) return (`/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`).replace(/\/+$/, '').toLowerCase();
        return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      } catch { return String(p || '').toLowerCase(); }
    };
    const needles = Array.from(new Set([canon(args.projectWslPath), canon(args.projectWinPath)].filter(Boolean)));
    const all = getIndexedSummaries();
    // Minimal probe logging (opt-in): only when CODEX_HISTORY_DEBUG=1
    const dbg = () => String((process as any).env.CODEX_HISTORY_DEBUG || '').trim() === '1';
    const dbgFile = String((process as any).env.CODEX_HISTORY_DEBUG_FILE || '').trim().toLowerCase();
    if (all && all.length > 0) {
      const startsWithBoundary = (child: string, parent: string): boolean => {
        try {
          const c = String(child || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
          const p = String(parent || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
          if (!c || !p) return false;
          if (c === p) return true;
          return c.startsWith(p + '/');
        } catch { return false; }
      };
      const filtered = needles.length === 0
        ? all
        : all.filter((s) => needles.some((n) => startsWithBoundary(s.dirKey, n)));
      try {
        if (dbg()) {
          const foundIdx = dbgFile ? all.some((x: any) => String(x.filePath || '').toLowerCase().includes(dbgFile)) : false;
          const foundFiltered = dbgFile ? filtered.some((x: any) => String(x.filePath || '').toLowerCase().includes(dbgFile)) : false;
          perfLogger.log(`[history:list:probe] needles=${JSON.stringify(needles)} all=${all.length} filtered=${filtered.length} foundIdx=${foundIdx} foundFiltered=${foundFiltered}`);
        }
      } catch {}
      // 若索引器有数据但按 dirKey 过滤后为空，针对指定项目路径回退到更稳妥的读取逻辑（全文前缀/启发式匹配）
      if (needles.length > 0 && filtered.length === 0) {
        try {
          const prefRoot = typeof args.historyRoot === 'string' && args.historyRoot.trim().length > 0 ? args.historyRoot : settings.getSettings().historyRoot;
          const res = await perfLogger.time('history.list.fallbackWhenEmpty', () => history.listHistory({ wslPath: args.projectWslPath, winPath: args.projectWinPath }, { limit: args.limit, offset: args.offset, historyRoot: prefRoot }));
          return { ok: true, sessions: res };
        } catch {}
      }
      const sorted = filtered.sort((a, b) => b.date - a.date);
      const offset = Math.max(0, Number(args.offset || 0));
      const end = args.limit ? offset + Number(args.limit) : undefined;
      const sliced = sorted.slice(offset, end);
      const mapped = sliced.map((x) => ({
        id: x.id,
        title: x.title,
        date: x.date,
        filePath: x.filePath,
        rawDate: x.rawDate,
        preview: (x as any).preview,
        resumeMode: (x as any).resumeMode,
        resumeId: (x as any).resumeId,
        runtimeShell: (x as any).runtimeShell,
      }));
      return { ok: true, sessions: mapped };
    }
    // 索引器未就绪时，回退到旧逻辑
    const prefRoot = typeof args.historyRoot === 'string' && args.historyRoot.trim().length > 0 ? args.historyRoot : settings.getSettings().historyRoot;
    const res = await perfLogger.time('history.list.fallback', () => history.listHistory({ wslPath: args.projectWslPath, winPath: args.projectWinPath }, { limit: args.limit, offset: args.offset, historyRoot: prefRoot }));
    return { ok: true, sessions: res };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('history.read', async (_e, { filePath }: { filePath: string }) => {
  try {
    const det = getIndexedDetails(filePath);
    if (det) return det;
  } catch {}
  return history.readHistoryFile(filePath);
});

// 扫描所有索引的会话，找出“筛选后 input_text/output_text 皆为空”的文件
ipcMain.handle('history.findEmptySessions', async () => {
  try {
    const sums = getIndexedSummaries();
    const candidates: { id: string; title: string; rawDate?: string; date: number; filePath: string }[] = [];
    for (const s of (sums || [])) {
      try {
        const det = getIndexedDetails(s.filePath) || null;
        let messages: any[] = [];
        let title = String((s as any).title || '');
        let rawDate = (s as any).rawDate ? String((s as any).rawDate) : undefined;
        let date = Number((s as any).date || 0);
        let id = String((s as any).id || '');
        if (det && det.messages) {
          messages = det.messages as any[];
          if (!title && (det as any).title) title = String((det as any).title);
          if (!rawDate && (det as any).rawDate) rawDate = String((det as any).rawDate);
          if (!date && (det as any).date) date = Number((det as any).date);
          if (!id && (det as any).id) id = String((det as any).id);
        } else {
          // 兜底读取（性能较差，仅在详情缓存缺失时触发）
          try {
            const r = await history.readHistoryFile(s.filePath);
            messages = r.messages as any[];
            if (!title && (r as any).title) title = String((r as any).title);
            if (!date && (r as any).date) date = Number((r as any).date);
            if (!id && (r as any).id) id = String((r as any).id);
          } catch {}
        }
        // 判定：仅统计 input_text / output_text，且需非空白文本
        let hasNonEmptyIO = false;
        for (const m of (messages || [])) {
          const items = Array.isArray((m as any).content) ? (m as any).content : [];
          for (const it of items) {
            const ty = String((it as any)?.type || '').toLowerCase();
            if (ty !== 'input_text' && ty !== 'output_text') continue;
            const txt = String((it as any)?.text || '').trim();
            if (txt.length > 0) { hasNonEmptyIO = true; break; }
          }
          if (hasNonEmptyIO) break;
        }
        if (!hasNonEmptyIO) {
          // 尝试获取文件大小（KB）以便前端显示
          let sizeKB = 0;
          try {
            const statCandidates: string[] = [];
            const push = (p?: string) => { if (p && !statCandidates.includes(p)) statCandidates.push(p); };
            const p0 = String(s.filePath);
            const normSlashes = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);
            if (process.platform === 'win32') {
              if (/^\//.test(p0)) {
                try { push(wsl.wslToUNC(p0, settings.getSettings().distro || 'Ubuntu-24.04')); } catch {}
                const m = p0.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
                if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
              }
            }
            push(normSlashes(p0));
            for (const cand of statCandidates) {
              try {
                if (fs.existsSync(cand)) {
                  const st = fs.statSync(cand);
                  if (st && typeof st.size === 'number') { sizeKB = Math.max(0, Math.round(st.size / 1024)); break; }
                }
              } catch {}
            }
          } catch {}
          candidates.push({ id, title, rawDate, date, filePath: s.filePath, sizeKB } as any);
        }
      } catch {}
    }
    return { ok: true, candidates } as any;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

// 批量彻底删除（逐个尝试）
ipcMain.handle('history.trashMany', async (_e, { filePaths }: { filePaths: string[] }) => {
  try {
    const results: { filePath: string; ok: boolean; notFound?: boolean; error?: string }[] = [];
    let okCount = 0; let notFoundCount = 0; let failCount = 0;
    const list = Array.isArray(filePaths) ? filePaths.slice() : [];
    // 并发限制器：避免一次性对大量文件触发过多 I/O / shell 调用
    const pLimitLocal = (max: number) => {
      let running = 0; const q: (() => void)[] = [];
      const next = () => { running--; const fn = q.shift(); if (fn) fn(); };
      return function <T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
          const run = () => {
            running++;
            task().then((v) => { next(); resolve(v); }).catch((e) => { next(); reject(e); });
          };
          if (running < max) run(); else q.push(run);
        });
      };
    };
    const limit = pLimitLocal(6);

    // 单个文件删除逻辑（保持原候选顺序）：彻底删除
    const handleOne = async (filePath: string) => {
      if (!filePath || typeof filePath !== 'string') return { filePath: String(filePath), ok: false, error: 'invalid filePath' };
      const candidates: string[] = [];
      const push = (p?: string) => { if (p && !candidates.includes(p)) candidates.push(p); };
      const normSlashes = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);
      const p0 = String(filePath);
      if (process.platform === 'win32') {
        if (/^\//.test(p0)) {
          try { push(wsl.wslToUNC(p0, settings.getSettings().distro || 'Ubuntu-24.04')); } catch {}
          const m = p0.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
          if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
        }
      }
      push(normSlashes(p0));
      const anyExists = candidates.some((c) => { try { return fs.existsSync(c); } catch { return false; } });
      if (!anyExists) return { filePath: p0, ok: true, notFound: true };
      let deleted = false; const failed: { cand: string; err: any }[] = [];
      for (const cand of candidates) {
        try {
          if (!fs.existsSync(cand)) { failed.push({ cand, err: 'not_exists' }); continue; }
          try {
            await fsp.rm(cand, { force: true });
            try { const idx = require('./indexer'); if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(cand); } catch {}
            try { const hist = require('./history').default; await hist.removePathFromCache(cand); } catch {}
            try { const win = BrowserWindow.getFocusedWindow(); win?.webContents.send('history:index:remove', { filePath: cand }); } catch {}
            deleted = true; break;
          } catch (e1: any) {
            failed.push({ cand, err: e1 });
          }
        } catch (e: any) { failed.push({ cand, err: e }); }
      }
      if (deleted) return { filePath: p0, ok: true };
      try {
        const hist = require('./history').default; try { await hist.removePathFromCache(p0); } catch {}
        const idx = require('./indexer'); try { if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(p0); } catch {}
      } catch {}
      const details = failed.map(f => `${f.cand}: ${String(f.err)}`).join('; ');
      return { filePath: p0, ok: false, error: `Failed to delete permanently (${details})` };
    };

    // 并发执行（限制并发数），收集结果
    const tasks = list.map((fp) => limit(() => handleOne(fp).catch((e) => ({ filePath: String(fp), ok: false, error: String(e) }))));
    const resArr = await Promise.all(tasks);
    for (const r of resArr) {
      results.push(r as any);
      if (r.ok) {
        // r 的具体类型可能不包含 notFound（例如已成功删除），
        // 因此显式检测属性存在性以满足 TypeScript 的类型检查。
        if ((r as any).notFound) notFoundCount++; else okCount++;
      } else failCount++;
    }

    return { ok: true, results, summary: { ok: okCount, notFound: notFoundCount, failed: failCount } } as any;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

// 彻底删除指定历史文件（支持 WSL/UNC/Windows 路径候选）
ipcMain.handle('history.trash', async (_e, { filePath }: { filePath: string }) => {
  try {
    if (!filePath || typeof filePath !== 'string') throw new Error('invalid filePath');
    const candidates: string[] = [];
    const push = (p?: string) => { if (p && !candidates.includes(p)) candidates.push(p); };
    const normSlashes = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);
    const p0 = String(filePath);
    // Windows 下候选顺序：
    // 1) POSIX -> UNC（跨发行版路径）
    // 2) /mnt/<drive> -> X:\ 盘符路径
    // 3) 原始路径
    if (process.platform === 'win32') {
      if (/^\//.test(p0)) {
        try { push(wsl.wslToUNC(p0, settings.getSettings().distro || 'Ubuntu-24.04')); } catch {}
        const m = p0.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
        if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
      }
    }
    push(normSlashes(p0));
    // 候选均不存在则视为成功（无需删除）
    const anyExists = candidates.some((c) => { try { return fs.existsSync(c); } catch { return false; } });
    if (!anyExists) return { ok: true, notFound: true } as any;
    // 依次尝试候选：永久删除
    const failed: { cand: string; err: any }[] = [];
    for (const cand of candidates) {
      try {
        if (!fs.existsSync(cand)) { failed.push({ cand, err: 'not_exists' }); continue; }
        try {
          await fsp.rm(cand, { force: true });
          // 删除成功：同步清理索引与历史缓存，并通知渲染进程移除该项
          try { const idx = require('./indexer'); if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(cand); } catch {}
          try { const hist = require('./history').default; await hist.removePathFromCache(cand); } catch {}
          try { const win = BrowserWindow.getFocusedWindow(); win?.webContents.send('history:index:remove', { filePath: cand }); } catch {}
          return { ok: true };
        } catch (e1: any) {
          failed.push({ cand, err: e1 });
        }
      } catch (e: any) {
        failed.push({ cand, err: e });
      }
    }
    const details = failed.map(f => `${f.cand}: ${String(f.err)}`).join('; ');
    // 若删除失败，仍尝试从索引与历史缓存中移除该路径，避免切换项目后缓存恢复已删除会话
    try {
      const hist = require('./history').default;
      try { await hist.removePathFromCache(filePath); } catch {}
    } catch {}
    try {
      const idx = require('./indexer');
      try { if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(filePath); } catch {}
    } catch {}
    throw new Error(`Failed to delete permanently (${details})`);
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// (trimmed) removed unused history.roots/listSplit/debugInfo handlers

// Utils: clipboard + save-as
ipcMain.handle('utils.copyText', async (_e, { text }: { text: string }) => {
  try { clipboard.writeText(String(text ?? '')); return { ok: true }; } catch (e: any) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('utils.readText', async () => {
  try {
    const text = clipboard.readText();
    return { ok: true, text };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.perfLog', async (_e, { text }: { text: string }) => {
  try { perfLogger.log(`[renderer] ${String(text ?? '')}`); return { ok: true }; } catch (e: any) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('utils.fetchJson', async (_e, { url, timeoutMs, headers }: { url: string; timeoutMs?: number; headers?: Record<string, string> }) => {
  try {
    if (!url || typeof url !== 'string') throw new Error('invalid url');
    const controller = new AbortController();
    const maxTimeout = Math.max(1000, Number(timeoutMs ?? 10000));
    const timer = setTimeout(() => controller.abort(), maxTimeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(headers || {})
        },
        redirect: 'follow'
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}`, raw: text };
      }
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch (e: any) {
        return { ok: false, status: res.status, error: `invalid_json: ${String(e?.message || e)}`, raw: text };
      }
      return { ok: true, status: res.status, data };
    } catch (err: any) {
      clearTimeout(timer);
      return { ok: false, error: String(err?.message || err) };
    }
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.saveText', async (_e, { content, defaultPath }: { content: string; defaultPath?: string }) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      defaultPath: defaultPath || 'history.txt',
      filters: [ { name: 'Text', extensions: ['txt'] }, { name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] } ]
    } as any;
    const ret = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (ret.canceled || !ret.filePath) return { ok: false, canceled: true };
    const fs = await import('node:fs/promises');
    await fs.writeFile(ret.filePath, String(content ?? ''), 'utf8');
    return { ok: true, path: ret.filePath };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.showInFolder', async (_e, { path: p }: { path: string }) => {
  try {
    if (!p || typeof p !== 'string') throw new Error('invalid path');
    const candidates: string[] = [];
    const push = (x?: string) => { if (x && !candidates.includes(x)) candidates.push(x); };
    const normSlashes = (s: string) => (process.platform === 'win32' ? s.replace(/\//g, '\\') : s);
    const raw = String(p);
    push(normSlashes(raw));
    if (process.platform === 'win32') {
      const m = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
      if (/^\//.test(raw)) {
        try { const unc = wsl.wslToUNC(raw, settings.getSettings().distro || 'Ubuntu-24.04'); push(unc); } catch {}
      }
    }
    // Try showItemInFolder for first existing file; else open containing directory
    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand)) {
          shell.showItemInFolder(cand);
          return { ok: true };
        }
        const dir = path.dirname(cand);
        if (fs.existsSync(dir)) {
          await shell.openPath(dir);
          return { ok: true, openedDir: dir };
        }
      } catch {}
    }
    throw new Error('no valid path');
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Images API：粘贴图片保存 & 剪贴板读取
ipcMain.handle('images.saveDataURL', async (_e, { dataURL, projectWinRoot, projectName, ext, prefix }: { dataURL: string; projectWinRoot?: string; projectName?: string; ext?: string; prefix?: string }) => {
  try {
    const res: any = await images.saveFromDataURL(dataURL, { projectWinRoot, projectName, ext, prefix });
    try { if (res && res.ok && typeof res.winPath === 'string') sessionPastedImages.add(res.winPath); } catch {}
    return res;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

ipcMain.handle('images.clipboardHasImage', async () => {
  try { return { ok: true, has: images.clipboardHasImage() }; } catch (e: any) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('images.saveFromClipboard', async (_e, { projectWinRoot, projectName, prefix }: { projectWinRoot?: string; projectName?: string; prefix?: string }) => {
  try {
    const res: any = await images.readClipboardAsPNGAndSave({ projectWinRoot, projectName, ext: 'png', prefix });
    try { if (res && res.ok && typeof res.winPath === 'string') sessionPastedImages.add(res.winPath); } catch {}
    return res;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

ipcMain.handle('images.trash', async (_e, { winPath }: { winPath: string }) => {
  try {
    if (!winPath || typeof winPath !== 'string') throw new Error('invalid path');
    try {
      await fsp.rm(winPath, { force: true });
      return { ok: true };
    } catch (e1: any) {
      return { ok: false, error: String(e1) };
    }
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.openPath', async (_e, { path: p }: { path: string }) => {
  try {
    if (!p || typeof p !== 'string') throw new Error('invalid path');
    const candidates: string[] = [];
    const push = (x?: string) => { if (x && !candidates.includes(x)) candidates.push(x); };
    const normSlashes = (s: string) => (process.platform === 'win32' ? s.replace(/\//g, '\\') : s);
    const raw = String(p);
    push(normSlashes(raw));
    if (process.platform === 'win32') {
      const m = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
      if (/^\//.test(raw)) {
        try { const unc = wsl.wslToUNC(raw, settings.getSettings().distro || 'Ubuntu-24.04'); push(unc); } catch {}
      }
    }
    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
        }
      } catch {}
    }
    throw new Error('no valid path');
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// 打开外部 URL（仅 http/https），避免在渲染进程使用 window.open 导致新窗口执行不受控脚本
ipcMain.handle('utils.openExternalUrl', async (_e, { url }: { url: string }) => {
  try {
    const s = String(url || '').trim();
    if (!/^https?:\/\//i.test(s)) throw new Error('invalid url');
    await shell.openExternal(s);
    return { ok: true } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

// 应用版本与资源路径（用于 About 页面与打开 LICENSE/NOTICE）
ipcMain.handle('app.getVersion', async () => {
  try { return { ok: true, version: app.getVersion() }; } catch (e: any) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('app.getPaths', async () => {
  try {
    const isDev = !app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
    const root = isDev ? process.cwd() : path.join(process.resourcesPath, 'app');
    const licensePath = path.join(root, 'LICENSE');
    const noticePath = path.join(root, 'NOTICE');
    return { ok: true, licensePath, noticePath } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

ipcMain.handle('app.getEnvMeta', async () => {
  try {
    const isDev = !app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
    const devServerUrl = String(process.env.DEV_SERVER_URL || '').trim();
    const protocol = devServerUrl && /^https?:/i.test(devServerUrl) ? 'http' : 'file';
    return { ok: true, isDev, devServerUrl: devServerUrl || null, protocol } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

// 打开外部 WSL 控制台（以“打开 WSL 终端 -> cd 到目录 -> 执行 codex”为准则，优先稳健性）
ipcMain.handle('utils.openExternalWSLConsole', async (_e, args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }) => {
  try {
    const platform = process.platform;
    const requestedDistro = String(args?.distro || settings.getSettings().distro || 'Ubuntu-24.04');
    let wslPath = String(args?.wslPath || '').trim();
    const winPath = String(args?.winPath || '').trim();
    const startupCmd = String(args?.startupCmd || settings.getSettings().codexCmd || 'codex');

    // 路径转换：若仅给了 Windows 路径，转换为 WSL 路径；均为空则使用 ~
    if (!wslPath && winPath) {
      try { wslPath = wsl.winToWsl(winPath, requestedDistro); } catch {}
    }
    if (!wslPath) wslPath = '~';

    // 组装 bash -lic 脚本：进入目录 -> 执行 codex -> 保持会话
    const esc = (s: string) => s.replace(/"/g, '\\"'); // 用于双引号内转义
    const cdCmd = wslPath === '~' ? 'cd ~' : `cd "${esc(wslPath)}"`;
    const bashScript = `${cdCmd}; ${startupCmd}; exec bash`;

    if (platform === 'win32') {
      // 仅当发行版存在时才附加 -d <distro>，否则回退到默认发行版
      const hasDistro = (() => { try { return wsl.distroExists(requestedDistro); } catch { return false; } })();
      const distroArgv = hasDistro ? ['-d', requestedDistro] as string[] : [];
      // 方案 A：cmd.exe /c start 直接开启新控制台，使用系统默认终端宿主（Windows 11 下通常是 Windows Terminal）
      const okCmdStart = await new Promise<boolean>((resolve) => {
        try {
          const child = spawn('cmd.exe', ['/c', 'start', '', 'wsl.exe', ...distroArgv, '--', 'bash', '-lic', bashScript], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.on('error', () => resolve(false));
          child.unref();
          resolve(true);
        } catch {
          resolve(false);
        }
      });
      if (okCmdStart) return { ok: true } as const;

      // 方案 B：Windows Terminal（new-tab，避免旧别名 nt），若存在则直接新开标签
      const trySpawn = (file: string, argv: string[]): Promise<boolean> => new Promise((resolve) => {
        try {
          const child = spawn(file, argv, { detached: true, stdio: 'ignore', windowsHide: true });
          child.on('error', () => resolve(false));
          child.unref();
          resolve(true);
        } catch { resolve(false); }
      });
      const wtArgs = ['-w', '0', 'new-tab', '--title', 'Codex', '--', 'wsl.exe', ...distroArgv, '--', 'bash', '-lic', bashScript];
      if (await trySpawn('wt.exe', wtArgs)) return { ok: true } as const;
      if (await trySpawn('WindowsTerminal.exe', wtArgs)) return { ok: true } as const;

      // 方案 C：PowerShell Start-Process（不依赖 --cd，直接在 bash 中 cd）
      const psArgListParts = [
        ...(hasDistro ? [`'-d'`, `'${requestedDistro.replace(/'/g, "''")}'`] : []),
        `'--'`, `'bash'`, `'-lic'`, `'${bashScript.replace(/'/g, "''")}'`
      ];
      const psCmd = `Start-Process -FilePath wsl.exe -ArgumentList @(${psArgListParts.join(',')})`;
      const okPS = await new Promise<boolean>((resolve) => {
        try {
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { detached: true, stdio: 'ignore', windowsHide: true });
          child.on('error', () => resolve(false));
          child.unref();
          resolve(true);
        } catch { resolve(false); }
      });
      if (okPS) return { ok: true } as const;

      throw new Error('failed to launch external WSL console');
    }

    // 非 Windows：尽力尝试常见终端（用于开发调试环境）
    const candidates: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', bashScript] },
      { cmd: 'konsole', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'xterm', args: ['-e', 'bash', '-lc', bashScript] },
    ];
    for (const c of candidates) {
      try {
        const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', cwd: process.env.HOME });
        child.on('error', () => {});
        child.unref();
        return { ok: true } as const;
      } catch {}
    }
    throw new Error('no terminal available');
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

// 打开选择目录对话并返回选中的 Windows 路径（若取消则返回 canceled）
ipcMain.handle('utils.chooseFolder', async (_e) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openDirectory'] } as any;
    const ret = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!ret || ret.canceled || !Array.isArray(ret.filePaths) || ret.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, path: ret.filePaths[0] };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Path helpers
ipcMain.handle('utils.pathExists', async (_e, args: { path: string; dirOnly?: boolean }) => {
  try {
    const p = String(args?.path || '');
    if (!p) return { ok: true, exists: false } as any;
    const fsp = await import('node:fs/promises');
    const st = await fsp.stat(p).catch(() => null as any);
    if (!st) return { ok: true, exists: false } as any;
    if (args?.dirOnly) return { ok: true, exists: st.isDirectory() } as any;
    return { ok: true, exists: true } as any;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

ipcMain.handle("codex.accountInfo", async () => {
  try {
    const bridge = ensureCodexBridge();
    const info = await bridge.getAccountInfo();
    return { ok: true, info };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("codex.rateLimit", async () => {
  try {
    const bridge = ensureCodexBridge();
    const snapshot = await bridge.getRateLimit();
    return { ok: true, snapshot };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Settings
ipcMain.handle('settings.get', async () => {
  try { await ensureSettingsAutodetect(); } catch {}
  try { await ensureAllCodexNotifications(); } catch {}
  return settings.getSettings();
});

ipcMain.handle('settings.update', async (_e, partial: any) => {
  try {
    if (partial && typeof partial.locale === 'string' && partial.locale.trim()) {
      // 使用 i18n 通道更新并广播语言，同时继续保存其它设置字段
      try { i18n.setCurrentLocale(String(partial.locale)); } catch {}
    }
  } catch {}
  const next = settings.updateSettings(partial || {});
  // 设置更新后尝试刷新代理
  try { await configureOrUpdateProxy(); } catch {}
  try { await ensureAllCodexNotifications(); } catch {}
  return next;
});

// Read-only: return the .codex/sessions roots that are currently in use (or can be detected quickly)
ipcMain.handle('settings.codexRoots', async () => {
  try {
    const fromIndexer = getLastIndexerRoots();
    if (fromIndexer && fromIndexer.length > 0) {
      // 仅返回仍存在的目录
      const fs = await import('node:fs/promises');
      const filtered: string[] = [];
      for (const r of fromIndexer) { try { const st = await fs.stat(r); if (st.isDirectory()) filtered.push(r); } catch {} }
      return { ok: true, roots: filtered };
    }
  } catch {}
  try {
    const roots = await getSessionsRootsFastAsync();
    return { ok: true, roots };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});
ipcMain.handle('storage.appData.info', async () => {
  try {
    return await storage.getAppDataInfo();
  } catch (e: any) {
    return {
      ok: false,
      path: '',
      totalBytes: 0,
      dirCount: 0,
      fileCount: 0,
      collectedAt: Date.now(),
      error: String(e),
    };
  }
});
ipcMain.handle('storage.appData.clear', async (_e, args: { preserveSettings?: boolean } = {}) => {
  try {
    return await storage.clearAppData(args);
  } catch (e: any) {
    return {
      ok: false,
      path: '',
      bytesBefore: 0,
      bytesAfter: 0,
      bytesFreed: 0,
      removedEntries: 0,
      skippedEntries: 0,
      error: String(e),
    };
  }
});
ipcMain.handle('storage.appData.purgeAndQuit', async () => {
  try {
    disposeAllPtys();
    disposeCodexBridges();
    await cleanupPastedImages();
    await stopHistoryIndexer();
    return await storage.purgeAppDataAndQuit();
  } catch (e: any) {
    return {
      ok: false,
      path: '',
      bytesBefore: 0,
      bytesAfter: 0,
      bytesFreed: 0,
      removedEntries: 0,
      skippedEntries: 0,
      error: String(e),
    };
  }
});

// 返回可用 WSL 发行版列表（仅列出名称）
ipcMain.handle('wsl.listDistros', async () => {
  try {
    const ds = await Promise.resolve(require('./wsl').listDistrosAsync());
    return { ok: true, distros: ds };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// WSL helpers
// (trimmed) removed unused wsl.* renderer IPC handlers
  // Debug term logs (main process PTY): expose IPC to get/set at runtime
  ipcMain.handle('utils.debugTerm.get', () => {
    try { return { ok: true, enabled: String(process.env.CODEX_TERM_DEBUG || '').trim() === '1' }; } catch { return { ok: true, enabled: false }; }
  });
  ipcMain.handle('utils.debugTerm.set', (_e, { enabled }: { enabled: boolean }) => {
    try { setTermDebug(!!enabled); (process as any).env.CODEX_TERM_DEBUG = enabled ? '1' : '0'; return { ok: true }; } catch (e: any) { return { ok: false, error: String(e) }; }
  });
