// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const { contextBridge, ipcRenderer } = require('electron');

type OpenArgs = { distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string };

contextBridge.exposeInMainWorld('host', {
  app: {
    getVersion: async (): Promise<string> => {
      try { const res = await ipcRenderer.invoke('app.getVersion'); return (res && res.ok) ? String(res.version || '') : ''; } catch { return ''; }
    },
    getPaths: async (): Promise<{ licensePath?: string; noticePath?: string }> => {
      try { const res = await ipcRenderer.invoke('app.getPaths'); if (res && res.ok) return { licensePath: res.licensePath, noticePath: res.noticePath }; return {}; } catch { return {}; }
    }
  },
  debug: {
    get: async (): Promise<any> => {
      try { return await ipcRenderer.invoke('debug.get'); } catch (e) { return { ok: false, error: String(e) } as any; }
    },
    update: async (partial: any): Promise<any> => {
      try { return await ipcRenderer.invoke('debug.update', partial); } catch (e) { return { ok: false, error: String(e) } as any; }
    },
    reset: async (): Promise<any> => {
      try { return await ipcRenderer.invoke('debug.reset'); } catch (e) { return { ok: false, error: String(e) } as any; }
    },
    onChanged: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('debug:changed', listener);
      return () => ipcRenderer.removeListener('debug:changed', listener);
    }
  },
  env: {
    getMeta: async (): Promise<{ ok: boolean; isDev?: boolean; devServerUrl?: string | null; protocol?: string; error?: string }> => {
      try { return await ipcRenderer.invoke('app.getEnvMeta'); } catch (e) { return { ok: false, error: String(e) } as any; }
    }
  },
  i18n: {
    getLocale: async (): Promise<{ ok: boolean; locale?: string; error?: string }> => {
      try { return await ipcRenderer.invoke('i18n.getLocale'); } catch (e) { return { ok: false, error: String(e) } as any; }
    },
    setLocale: async (locale: string): Promise<{ ok: boolean; locale?: string; error?: string }> => {
      try { return await ipcRenderer.invoke('i18n.setLocale', { locale }); } catch (e) { return { ok: false, error: String(e) } as any; }
    },
    onLocaleChanged: (handler: (payload: { locale: string }) => void) => {
      const listener = (_: unknown, payload: { locale: string }) => handler(payload);
      ipcRenderer.on('i18n:localeChanged', listener);
      return () => ipcRenderer.removeListener('i18n:localeChanged', listener);
    },
    userLocales: {
      dir: async (): Promise<{ ok: boolean; dir?: string; error?: string }> => {
        try { return await ipcRenderer.invoke('i18n.userLocales.dir'); } catch (e) { return { ok: false, error: String(e) } as any; }
      },
      list: async (): Promise<{ ok: boolean; languages?: string[]; error?: string }> => {
        try { return await ipcRenderer.invoke('i18n.userLocales.list'); } catch (e) { return { ok: false, error: String(e) } as any; }
      },
      read: async (lng: string, ns: string): Promise<{ ok: boolean; data?: any; error?: string }> => {
        try { return await ipcRenderer.invoke('i18n.userLocales.read', { lng, ns }); } catch (e) { return { ok: false, error: String(e) } as any; }
      }
    }
  },
  pty: {
    openWSLConsole: async (args: OpenArgs): Promise<{ id: string }> => {
      return await ipcRenderer.invoke('pty:open', args);
    },
    write: (id: string, data: string) => {
      ipcRenderer.send('pty:write', { id, data });
    },
    resize: (id: string, cols: number, rows: number) => {
      ipcRenderer.send('pty:resize', { id, cols, rows });
    },
    close: (id: string) => {
      ipcRenderer.send('pty:close', { id });
    },
    // 可选：在 resize 期间“暂停-同步-恢复”，以及与 ConPTY 同步清屏
    pause: (id: string) => { ipcRenderer.send('pty:pause', { id }); },
    resume: (id: string) => { ipcRenderer.send('pty:resume', { id }); },
    clear: (id: string) => { ipcRenderer.send('pty:clear', { id }); },
    onData: (id: string, handler: (data: string) => void) => {
      const listener = (_: unknown, payload: { id: string; data: string }) => {
        if (payload.id === id) handler(payload.data);
      };
      ipcRenderer.on('pty:data', listener);
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
    onExit: (handler: (payload: { id: string; exitCode?: number }) => void) => {
      const listener = (_: unknown, payload: { id: string; exitCode?: number }) => handler(payload);
      ipcRenderer.on('pty:exit', listener);
      return () => ipcRenderer.removeListener('pty:exit', listener);
    },
  },
  fileIndex: {
    ensureIndex: async (args: { root: string; excludes?: string[] }) => {
      return await ipcRenderer.invoke('fileIndex.ensure', args);
    },
    getAllCandidates: async (root: string) => {
      return await ipcRenderer.invoke('fileIndex.candidates', { root });
    },
    setActiveRoots: async (roots: string[]) => {
      return await ipcRenderer.invoke('fileIndex.activeRoots', { roots });
    },
    // 订阅文件索引变更：用于前端热刷新 @ 搜索候选
    onChanged: (handler: (payload: { root: string; reason?: string; adds?: { rel: string; isDir: boolean }[]; removes?: { rel: string; isDir: boolean }[] }) => void) => {
      const listener = (_: unknown, payload: any) => handler(payload);
      ipcRenderer.on('fileIndex:changed', listener);
      return () => ipcRenderer.removeListener('fileIndex:changed', listener);
    },
  },
  projects: {
    scan: async (args: { roots?: string[] } = {}) => {
      return await ipcRenderer.invoke('projects.scan', args);
    },
    add: async (args: { winPath: string }) => {
      return await ipcRenderer.invoke('projects.add', args);
    },
    touch: (id: string) => {
      ipcRenderer.send('projects.touch', { id });
    }
  },
  history: {
    list: async (args: { projectWslPath?: string; projectWinPath?: string; limit?: number; offset?: number; historyRoot?: string }) => {
      return await ipcRenderer.invoke('history.list', args);
    },
    read: async (args: { filePath: string }) => {
      return await ipcRenderer.invoke('history.read', args);
    },
    findEmptySessions: async () => {
      return await ipcRenderer.invoke('history.findEmptySessions');
    },
    trash: async (args: { filePath: string }) => {
      return await ipcRenderer.invoke('history.trash', args);
    },
    trashMany: async (args: { filePaths: string[] }) => {
      return await ipcRenderer.invoke('history.trashMany', args);
    },
    onIndexAdd: (handler: (payload: { items: any[] }) => void) => {
      const listener = (_: unknown, payload: { items: any[] }) => handler(payload);
      ipcRenderer.on('history:index:add', listener);
      return () => ipcRenderer.removeListener('history:index:add', listener);
    },
    onIndexUpdate: (handler: (payload: { item: any }) => void) => {
      const listener = (_: unknown, payload: { item: any }) => handler(payload);
      ipcRenderer.on('history:index:update', listener);
      return () => ipcRenderer.removeListener('history:index:update', listener);
    },
    onIndexRemove: (handler: (payload: { filePath: string }) => void) => {
      const listener = (_: unknown, payload: { filePath: string }) => handler(payload);
      ipcRenderer.on('history:index:remove', listener);
      return () => ipcRenderer.removeListener('history:index:remove', listener);
    },
    
  },
  settings: {
    get: async () => {
      return await ipcRenderer.invoke('settings.get');
    },
    update: async (partial: any) => {
      return await ipcRenderer.invoke('settings.update', partial);
    },
    codexRoots: async () => {
      const res = await ipcRenderer.invoke('settings.codexRoots');
      if (res && res.ok && Array.isArray(res.roots)) return res.roots as string[];
      return [] as string[];
    },
  },
  storage: {
    getAppDataInfo: async () => {
      return await ipcRenderer.invoke('storage.appData.info');
    },
    clearAppData: async (args?: { preserveSettings?: boolean }) => {
      return await ipcRenderer.invoke('storage.appData.clear', args);
    },
    purgeAppDataAndQuit: async () => {
      return await ipcRenderer.invoke('storage.appData.purgeAndQuit');
    },
  },
  wsl: {
    listDistros: async () => {
      const res = await ipcRenderer.invoke('wsl.listDistros');
      if (res && res.ok && Array.isArray(res.distros)) return res as { ok: true; distros: string[] };
      return { ok: false, distros: [] } as any;
    }
  }
  , codex: {
    getAccountInfo: async () => {
      return await ipcRenderer.invoke('codex.accountInfo');
    },
    getRateLimit: async () => {
      return await ipcRenderer.invoke('codex.rateLimit');
    }
  }
  , notifications: {
    setBadgeCount: (count: number) => {
      ipcRenderer.send('notifications:setBadge', { count });
    },
    showAgentCompletion: (payload: { tabId: string; tabName?: string; projectName?: string; preview?: string; title: string; body: string; appTitle?: string }) => {
      ipcRenderer.send('notifications:agentComplete', payload);
    },
    onFocusTab: (handler: (payload: { tabId: string }) => void) => {
      const listener = (_: unknown, payload: { tabId: string }) => handler(payload);
      ipcRenderer.on('notifications:focus-tab', listener);
      return () => ipcRenderer.removeListener('notifications:focus-tab', listener);
    }
  }
  , utils: {
    perfLog: async (text: string) => {
      try { return await ipcRenderer.invoke('utils.perfLog', { text }); } catch (e) { return { ok: false, error: String(e) }; }
    },
    getWindowsInfo: async (): Promise<{ ok: boolean; platform?: string; buildNumber?: number; backend?: string; conptyAvailable?: boolean; error?: string }> => {
      try { return await ipcRenderer.invoke('utils.getWindowsInfo'); } catch (e) { return { ok: false, error: String(e) } as any; }
    },
    // 主进程 PTY 日志开关：默认关闭；可在控制台调用 setDebugTerm(true/false)
    debugTermGet: async (): Promise<{ ok: boolean; enabled?: boolean; error?: string }> => {
      try { return await ipcRenderer.invoke('utils.debugTerm.get'); } catch (e) { return { ok: false, error: String(e) }; }
    },
    debugTermSet: async (enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      try { return await ipcRenderer.invoke('utils.debugTerm.set', { enabled }); } catch (e) { return { ok: false, error: String(e) }; }
    },
    copyText: async (text: string) => {
      return await ipcRenderer.invoke('utils.copyText', { text });
    },
    readText: async () => {
      return await ipcRenderer.invoke('utils.readText');
    },
    saveText: async (content: string, defaultPath?: string) => {
      return await ipcRenderer.invoke('utils.saveText', { content, defaultPath });
    },
    fetchJson: async (args: { url: string; timeoutMs?: number; headers?: Record<string, string> }) => {
      try { return await ipcRenderer.invoke('utils.fetchJson', args); } catch (e) { return { ok: false, error: String(e) }; }
    },
    showInFolder: async (p: string) => {
      return await ipcRenderer.invoke('utils.showInFolder', { path: p });
    },
    openPath: async (p: string) => {
      return await ipcRenderer.invoke('utils.openPath', { path: p });
    },
    openExternalUrl: async (url: string) => {
      return await ipcRenderer.invoke('utils.openExternalUrl', { url });
    },
    openExternalConsole: async (args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }) => {
      return await ipcRenderer.invoke('utils.openExternalConsole', args);
    },
    // 兼容旧调用名
    openExternalWSLConsole: async (args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }) => {
      return await ipcRenderer.invoke('utils.openExternalConsole', args);
    },
    pathExists: async (p: string, dirOnly?: boolean) => {
      return await ipcRenderer.invoke('utils.pathExists', { path: p, dirOnly });
    }
    , chooseFolder: async () => {
      return await ipcRenderer.invoke('utils.chooseFolder');
    }
  }
  , images: {
    saveDataURL: async (args: { dataURL: string; projectWinRoot?: string; projectName?: string; ext?: string; prefix?: string }) => {
      return await ipcRenderer.invoke('images.saveDataURL', args);
    },
    clipboardHasImage: async () => {
      return await ipcRenderer.invoke('images.clipboardHasImage');
    },
    saveFromClipboard: async (args: { projectWinRoot?: string; projectName?: string; prefix?: string }) => {
      return await ipcRenderer.invoke('images.saveFromClipboard', args);
    },
    trash: async (args: { winPath: string }) => {
      return await ipcRenderer.invoke('images.trash', args);
    }
  }
});

// 确保预加载脚本以 CommonJS 导出，避免打包后在非模块环境使用 import 失败
module.exports = {};

// ---- 统一调试配置：同步关键项到全局只读缓存（供渲染层直接读取，避免多次 IPC）----
function __applyDebugGlobals(cfg: any) {
  try {
    (globalThis as any).__cf_ui_debug_cache__ = !!(cfg?.renderer?.uiDebug);
    (globalThis as any).__cf_notif_debug_cache__ = !!(cfg?.renderer?.notifications?.debug);
    (globalThis as any).__cf_notif_menu_mode__ = String(cfg?.renderer?.notifications?.menu || 'auto');
    (globalThis as any).__cf_term_debug__ = !!(cfg?.terminal?.frontend?.debug);
    (globalThis as any).__cf_disable_pin__ = !!(cfg?.terminal?.frontend?.disablePin);
    (globalThis as any).__cf_at_debug__ = !!(cfg?.renderer?.atSearchDebug);
    (globalThis as any).__cf_updates_skip__ = String(cfg?.updates?.skipVersion || '');
  } catch {}
}

async function __refreshDebugGlobals() {
  try { const cfg = await ipcRenderer.invoke('debug.get'); __applyDebugGlobals(cfg); } catch {}
}

try { __refreshDebugGlobals(); } catch {}
ipcRenderer.on('debug:changed', () => { try { __refreshDebugGlobals(); } catch {} });

// ---- 渲染进程诊断日志（根据统一配置 global.diagLog 控制）----
try {
  (async () => {
    let DIAG = false;
    try { const cfg = await ipcRenderer.invoke('debug.get'); DIAG = !!(cfg && cfg.global && cfg.global.diagLog); } catch {}
    if (DIAG) {
      window.addEventListener('error', (e) => {
        try { ipcRenderer.invoke('utils.perfLog', { text: `[renderer:error] ${e?.message} at ${e?.filename}:${e?.lineno}:${e?.colno}` }); } catch {}
      });
      window.addEventListener('unhandledrejection', (e) => {
        try {
          const reason = (e as any)?.reason;
          const msg = typeof reason === 'string' ? reason : (reason && (reason.stack || reason.message)) || String(reason);
          ipcRenderer.invoke('utils.perfLog', { text: `[renderer:unhandledrejection] ${msg}` });
        } catch {}
      });
      const _err = console.error.bind(console);
      console.error = (...args: any[]) => {
        try { ipcRenderer.invoke('utils.perfLog', { text: `[console.error] ${args.map((x) => (typeof x === 'string' ? x : (x && (x.stack || x.message)) || JSON.stringify(x))).join(' ')}` }); } catch {}
        try { _err(...args); } catch {}
      };
      const _warn = console.warn.bind(console);
      console.warn = (...args: any[]) => {
        try { ipcRenderer.invoke('utils.perfLog', { text: `[console.warn] ${args.map((x) => (typeof x === 'string' ? x : (x && (x.stack || x.message)) || JSON.stringify(x))).join(' ')}` }); } catch {}
        try { _warn(...args); } catch {}
      };
    }
  })();
} catch {}
