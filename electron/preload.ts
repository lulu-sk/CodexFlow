// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const { contextBridge, ipcRenderer } = require('electron');
// preload 层：集中做 IPC 分发与安全封装

type OpenArgs = { terminal?: 'wsl' | 'windows' | 'pwsh'; distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string; env?: Record<string, string> };

type PtyDataPayload = { id: string; data: string };
type PtyExitPayload = { id: string; exitCode?: number };

// ---- PTY 事件分发（关键性能修复）----
// 中文说明：
// - 旧实现：每次 `window.host.pty.onData(id, cb)` 都会 `ipcRenderer.on('pty:data', ...)` 注册一个监听器；
//   当存在多个终端/多个订阅（例如 xterm 渲染 + 完成通知解析）时，会导致每条输出被重复分发 N 次，
//   在高频输出场景下会显著放大 CPU 开销，并最终表现为页面白屏/渲染进程崩溃（但主进程 PTY 仍在跑）。
// - 新实现：preload 仅注册 **一个** `ipcRenderer` 监听器，然后按 ptyId 分发给订阅者集合，避免 O(N) 放大。

// 中文说明：
// - Electron 渲染进程发生 reload/HMR 时，preload 可能会再次执行；若仍使用“模块级布尔值”防重，容易导致重复安装 ipcRenderer 监听器；
// - 这里将“单例监听器与 handler 容器”挂到 renderer process 的 `process` 上（Symbol.for），确保跨 reload 仍然是单例；
// - 同时在每次 preload 执行时清空旧 handler，避免旧页面闭包被持有导致内存泄漏与重复分发。

const SYM_PTY_DATA_HANDLERS = Symbol.for("codexflow:ptyDataHandlersById");
const SYM_PTY_EXIT_HANDLERS = Symbol.for("codexflow:ptyExitHandlers");
const SYM_PTY_DATA_LISTENER = Symbol.for("codexflow:ptyDataListener");
const SYM_PTY_EXIT_LISTENER = Symbol.for("codexflow:ptyExitListener");

const gProc: any = process as any;
const ptyDataHandlersById: Map<string, Set<(data: string) => void>> = (gProc[SYM_PTY_DATA_HANDLERS] as any) || new Map();
gProc[SYM_PTY_DATA_HANDLERS] = ptyDataHandlersById;
try { ptyDataHandlersById.clear(); } catch {}

const ptyExitHandlers: Set<(payload: PtyExitPayload) => void> = (gProc[SYM_PTY_EXIT_HANDLERS] as any) || new Set();
gProc[SYM_PTY_EXIT_HANDLERS] = ptyExitHandlers;
try { ptyExitHandlers.clear(); } catch {}

/**
 * 中文说明：安装 PTY data 分发器（全局仅一次）。
 */
function ensurePtyDataDispatcher(): void {
  const existing = (gProc as any)[SYM_PTY_DATA_LISTENER];
  if (existing) return;
  const listener = (_: unknown, payload: PtyDataPayload) => {
    try {
      const id = String(payload?.id || '');
      if (!id) return;
      const map: Map<string, Set<(data: string) => void>> = (gProc as any)[SYM_PTY_DATA_HANDLERS] || ptyDataHandlersById;
      const set = map.get(id);
      if (!set || set.size === 0) return;
      const data = typeof payload?.data === 'string' ? payload.data : String(payload?.data ?? '');
      // 中文说明：对 Set 做快照迭代，避免回调内部增删订阅导致迭代语义不稳定。
      for (const cb of Array.from(set)) {
        try { cb(data); } catch {}
      }
    } catch {}
  };
  (gProc as any)[SYM_PTY_DATA_LISTENER] = listener;
  ipcRenderer.on('pty:data', listener);
}

/**
 * 中文说明：安装 PTY exit 分发器（全局仅一次）。
 */
function ensurePtyExitDispatcher(): void {
  const existing = (gProc as any)[SYM_PTY_EXIT_LISTENER];
  if (existing) return;
  const listener = (_: unknown, payload: PtyExitPayload) => {
    try {
      const evt: PtyExitPayload = { id: String(payload?.id || ''), exitCode: (payload as any)?.exitCode };
      if (!evt.id) return;
      // 中文说明：收到 exit 后，自动清理该 PTY 的 data handlers，避免泄漏（即便业务侧忘记 unsubscribe）。
      try {
        const map: Map<string, Set<(data: string) => void>> = (gProc as any)[SYM_PTY_DATA_HANDLERS] || ptyDataHandlersById;
        map.delete(evt.id);
      } catch {}
      // 中文说明：对 Set 做快照迭代，避免回调内部增删订阅导致迭代语义不稳定。
      const set: Set<(payload: PtyExitPayload) => void> = (gProc as any)[SYM_PTY_EXIT_HANDLERS] || ptyExitHandlers;
      for (const cb of Array.from(set)) {
        try { cb(evt); } catch {}
      }
    } catch {}
  };
  (gProc as any)[SYM_PTY_EXIT_LISTENER] = listener;
  ipcRenderer.on('pty:exit', listener);
}

/**
 * 中文说明：从主进程继承的本次启动 bootId。
 * - 主进程在启动时写入 `process.env.CODEXFLOW_APP_BOOT_ID`
 * - preload 在每次 document load/reload 时都会重新执行，因此必须读取一个“跨 reload 稳定”的值
 */
const APP_BOOT_ID = String(process.env.CODEXFLOW_APP_BOOT_ID || "");

contextBridge.exposeInMainWorld('host', {
  app: {
    bootId: APP_BOOT_ID,
    getVersion: async (): Promise<string> => {
      try { const res = await ipcRenderer.invoke('app.getVersion'); return (res && res.ok) ? String(res.version || '') : ''; } catch { return ''; }
    },
    getPaths: async (): Promise<{ licensePath?: string; noticePath?: string }> => {
      try { const res = await ipcRenderer.invoke('app.getPaths'); if (res && res.ok) return { licensePath: res.licensePath, noticePath: res.noticePath }; return {}; } catch { return {}; }
    },
    setTitleBarTheme: async (theme: { mode: 'light' | 'dark'; source?: 'light' | 'dark' | 'system' } | 'light' | 'dark'): Promise<{ ok: boolean; error?: string }> => {
      try {
        const payload = typeof theme === 'string' ? { mode: theme } : theme;
        return await ipcRenderer.invoke('app.setTitleBarTheme', payload);
      } catch (e) { return { ok: false, error: String(e) } as any; }
    },
    /**
     * 监听主进程发起的“退出确认”请求（用于渲染进程自定义弹窗样式）。
     */
    onQuitConfirm: (handler: (payload: { token: string; count: number }) => void) => {
      const listener = (_: unknown, payload: { token: string; count: number }) => handler(payload);
      ipcRenderer.on('app:quitConfirm', listener);
      return () => ipcRenderer.removeListener('app:quitConfirm', listener);
    },
    /**
     * 回复主进程的“退出确认”结果。
     */
    respondQuitConfirm: async (token: string, ok: boolean): Promise<{ ok: boolean; error?: string }> => {
      try { return await ipcRenderer.invoke('app.quitConfirm.respond', { token, ok }); } catch (e) { return { ok: false, error: String(e) } as any; }
    },
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
    /**
     * 中文说明：读取指定 PTY 的尾部输出缓存（用于渲染进程 reload/HMR 后恢复滚动区）。
     */
    backlog: async (id: string, args?: { maxChars?: number }): Promise<{ ok: boolean; data?: string; error?: string }> => {
      try { return await ipcRenderer.invoke('pty:backlog', { id, maxChars: args?.maxChars }); } catch (e) { return { ok: false, error: String(e) } as any; }
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
      ensurePtyDataDispatcher();
      const key = String(id || '');
      if (!key) return () => {};
      let set = ptyDataHandlersById.get(key);
      if (!set) {
        set = new Set();
        ptyDataHandlersById.set(key, set);
      }
      set.add(handler);
      return () => {
        try {
          const cur = ptyDataHandlersById.get(key);
          if (!cur) return;
          cur.delete(handler);
          if (cur.size === 0) ptyDataHandlersById.delete(key);
        } catch {}
      };
    },
    onExit: (handler: (payload: { id: string; exitCode?: number }) => void) => {
      ensurePtyExitDispatcher();
      ptyExitHandlers.add(handler as any);
      return () => {
        try { ptyExitHandlers.delete(handler as any); } catch {}
      };
    },
  },
  fileIndex: {
    ensureIndex: async (args: { root: string; excludes?: string[] }) => {
      return await ipcRenderer.invoke('fileIndex.ensure', args);
    },
    getAllCandidates: async (root: string) => {
      return await ipcRenderer.invoke('fileIndex.candidates', { root });
    },
    /**
     * 中文说明：主进程侧 @ 搜索（仅返回 topN，避免全量候选跨进程搬运）。
     */
    searchAt: async (args: { root: string; query: string; scope?: 'all' | 'files' | 'rule'; limit?: number; excludes?: string[] }) => {
      return await ipcRenderer.invoke('fileIndex.searchAt', args);
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
    /** 读取缓存项目列表（不触发扫描） */
    list: async () => {
      return await ipcRenderer.invoke('projects.list');
    },
    scan: async (args: { roots?: string[] } = {}) => {
      return await ipcRenderer.invoke('projects.scan', args);
    },
    add: async (args: { winPath: string; dirRecord?: { providerId: string; recordedAt?: number } }) => {
      return await ipcRenderer.invoke('projects.add', args);
    },
    removeDirRecord: async (args: { id: string }) => {
      return await ipcRenderer.invoke('projects.removeDirRecord', args);
    },
    touch: (id: string) => {
      ipcRenderer.send('projects.touch', { id });
    }
  },
  dirTree: {
    /** 读取目录树（仅 UI 结构持久化，不触发扫描）。 */
    get: async () => {
      return await ipcRenderer.invoke("dirTree.get");
    },
    /** 写入目录树（整包覆盖）。 */
    set: async (store: any) => {
      return await ipcRenderer.invoke("dirTree.set", { store });
    },
  },
  buildRun: {
    /** 读取某目录的 Build/Run 配置（Key=目录绝对路径）。 */
    get: async (dir: string) => {
      return await ipcRenderer.invoke("buildRun.get", { dir });
    },
    /** 写入某目录的 Build/Run 配置（整包覆盖）。 */
    set: async (dir: string, cfg: any) => {
      return await ipcRenderer.invoke("buildRun.set", { dir, cfg });
    },
    /** 在外部终端执行 Build/Run（硬性：不走内置 PTY）。 */
    exec: async (args: any) => {
      return await ipcRenderer.invoke("buildRun.exec", args);
    },
  },
  gitWorktree: {
    /** 批量读取 git 状态（仓库/工作树识别、分支、detached）。 */
    statusBatch: async (dirs: string[]) => {
      return await ipcRenderer.invoke("gitWorktree.statusBatch", { dirs });
    },
    /** 读取分支列表（仅本地分支）。 */
    listBranches: async (repoDir: string) => {
      return await ipcRenderer.invoke("gitWorktree.listBranches", { repoDir });
    },
    /** 读取 worktree 的创建元数据（用于回收/删除等默认分支选择）。 */
    getMeta: async (worktreePath: string) => {
      return await ipcRenderer.invoke("gitWorktree.getMeta", { worktreePath });
    },
    /** 从分支创建 worktree（支持多实例）。 */
    create: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.create", args);
    },
    /** 启动（或复用）worktree 创建后台任务（用于进度 UI）。 */
    createTaskStart: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.createTaskStart", args);
    },
    /** 获取 worktree 创建任务状态，并按偏移增量返回日志。 */
    createTaskGet: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.createTaskGet", args);
    },
    /** 请求取消 worktree 创建任务（并回滚清理已创建资源）。 */
    createTaskCancel: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.createTaskCancel", args);
    },
    /** 启动（或复用）worktree 回收后台任务（用于进度 UI）。 */
    recycleTaskStart: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.recycleTaskStart", args);
    },
    /** 获取 worktree 回收任务状态，并按偏移增量返回日志。 */
    recycleTaskGet: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.recycleTaskGet", args);
    },
    /** 回收 worktree 变更到基分支（squash/rebase）。 */
    recycle: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.recycle", args);
    },
    /** 解析 worktree 的分叉点（用于“仅分叉点之后回收”的 UI 展示与手动校验）。 */
    resolveForkPoint: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.resolveForkPoint", args);
    },
    /** 搜索可用作“分叉点”的提交列表（用于下拉框搜索）。 */
    searchForkPointCommits: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.searchForkPointCommits", args);
    },
    /** 校验用户手动输入的分叉点引用（提交号/引用名），并返回提交摘要。 */
    validateForkPointRef: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.validateForkPointRef", args);
    },
    /** 删除 worktree（可选同时删除分支）。 */
    remove: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.remove", args);
    },
    /** 对齐 worktree 到主工作区当前基线，并恢复为干净状态（保持目录，不删除）。 */
    reset: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.reset", args);
    },
    /** 检测 worktree 是否已与主工作区当前基线对齐（只读，不修改状态）。 */
    isAlignedToMain: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.isAlignedToMain", args);
    },
    /** worktree 自动提交（有变更才提交）。 */
    autoCommit: async (args: any) => {
      return await ipcRenderer.invoke("gitWorktree.autoCommit", args);
    },
    /** 在外部 Git 工具打开目录。 */
    openExternalTool: async (dir: string) => {
      return await ipcRenderer.invoke("gitWorktree.openExternalTool", { dir });
    },
    /** 在该目录打开终端（Windows 优先 Git Bash）。 */
    openTerminal: async (dir: string) => {
      return await ipcRenderer.invoke("gitWorktree.openTerminal", { dir });
    },
  },
  history: {
    list: async (args: { projectWslPath?: string; projectWinPath?: string; limit?: number; offset?: number; historyRoot?: string }) => {
      return await ipcRenderer.invoke('history.list', args);
    },
    read: async (args: { filePath: string; providerId?: "codex" | "claude" | "gemini" }) => {
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
    onIndexInvalidate: (handler: (payload: { reason?: string }) => void) => {
      const listener = (_: unknown, payload: { reason?: string }) => handler(payload || {} as any);
      ipcRenderer.on('history:index:invalidate', listener);
      return () => ipcRenderer.removeListener('history:index:invalidate', listener);
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
    sessionRoots: async (args: { providerId: "codex" | "claude" | "gemini" }) => {
      const res = await ipcRenderer.invoke('settings.sessionRoots', args);
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
    listAutoProfiles: async () => {
      return await ipcRenderer.invoke('storage.autoProfiles.info');
    },
    purgeAutoProfiles: async (args?: { includeCurrent?: boolean }) => {
      return await ipcRenderer.invoke('storage.autoProfiles.purge', args);
    },
    listWorktreeProfiles: async () => {
      return await ipcRenderer.invoke('storage.worktreeProfiles.info');
    },
    purgeWorktreeProfiles: async (args?: { includeCurrent?: boolean }) => {
      return await ipcRenderer.invoke('storage.worktreeProfiles.purge', args);
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
    ,
    listAuthBackups: async () => {
      return await ipcRenderer.invoke('codex.authBackups.list');
    },
    applyAuthBackup: async (args: { id: string }) => {
      return await ipcRenderer.invoke('codex.authBackups.apply', args);
    },
    deleteAuthBackup: async (args: { id: string }) => {
      return await ipcRenderer.invoke('codex.authBackups.delete', args);
    }
  }
  , claude: {
    getUsage: async () => {
      return await ipcRenderer.invoke('claude.usage');
    }
  }
  , gemini: {
    getUsage: async () => {
      return await ipcRenderer.invoke('gemini.usage');
    }
  }
  , notifications: {
    setBadgeCount: (count: number) => {
      ipcRenderer.send('notifications:setBadge', { count });
    },
    showAgentCompletion: (payload: { tabId: string; tabName?: string; projectName?: string; preview?: string; title: string; body: string; appTitle?: string }) => {
      ipcRenderer.send('notifications:agentComplete', payload);
    },
    // 中文说明：监听主进程转发的外部完成通知（Gemini/Claude hook -> JSONL 桥接）。
    onExternalAgentComplete: (handler: (payload: any) => void) => {
      const listener = (_: unknown, payload: any) => handler(payload);
      ipcRenderer.on('notifications:externalAgentComplete', listener);
      return () => ipcRenderer.removeListener('notifications:externalAgentComplete', listener);
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
    /**
     * 中文说明：将路径转换为当前系统可直接使用的格式（如 Windows 盘符路径）。
     */
    normalizePathForClipboard: async (p: string) => {
      return await ipcRenderer.invoke('utils.normalizePathForClipboard', { path: p });
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
    openPathAtPosition: async (p: string, pos?: { line?: number; column?: number; projectPath?: string }) => {
      return await ipcRenderer.invoke('utils.openPathAtPosition', { path: p, line: pos?.line, column: pos?.column, projectPath: pos?.projectPath });
    },
    // 中文说明：读取项目绑定的 IDE（用于“按项目复用已打开 IDE”跳转策略）。
    getProjectPreferredIde: async (projectPath: string) => {
      return await ipcRenderer.invoke("utils.projectIde.get", { projectPath });
    },
    // 中文说明：设置或清除项目绑定的 IDE（兼容旧版 ideId 字符串与新版结构化 config）。
    // - 清除绑定请显式传入 null，避免遗漏参数导致误清除。
    setProjectPreferredIde: async (
      projectPath: string,
      config: { mode?: "builtin" | "custom"; builtinId?: "vscode" | "cursor" | "windsurf" | "rider"; customName?: string; customCommand?: string } | "vscode" | "cursor" | "windsurf" | "rider" | null,
    ) => {
      if (typeof config === "string" || config === null) {
        return await ipcRenderer.invoke("utils.projectIde.set", { projectPath, ideId: config ?? null });
      }
      return await ipcRenderer.invoke("utils.projectIde.set", { projectPath, config });
    },
    openExternalUrl: async (url: string) => {
      return await ipcRenderer.invoke('utils.openExternalUrl', { url });
    },
    openExternalConsole: async (args: { terminal?: 'wsl' | 'windows' | 'pwsh'; wslPath?: string; winPath?: string; distro?: string; startupCmd?: string; title?: string }) => {
      return await ipcRenderer.invoke('utils.openExternalConsole', args);
    },
    // 兼容旧调用名
    openExternalWSLConsole: async (args: { terminal?: 'wsl' | 'windows' | 'pwsh'; wslPath?: string; winPath?: string; distro?: string; startupCmd?: string; title?: string }) => {
      return await ipcRenderer.invoke('utils.openExternalConsole', args);
    },
    pathExists: async (p: string, dirOnly?: boolean) => {
      return await ipcRenderer.invoke('utils.pathExists', { path: p, dirOnly });
    }
    /** 获取当前用户主目录路径（轻量）。 */
    , getHomeDir: async () => {
      return await ipcRenderer.invoke('utils.getHomeDir');
    }
    , chooseFolder: async () => {
      return await ipcRenderer.invoke('utils.chooseFolder');
    }
    , listFonts: async (): Promise<string[]> => {
      try { const res = await ipcRenderer.invoke('utils.listFonts'); if (res && res.ok && Array.isArray(res.fonts)) return res.fonts as string[]; return []; } catch { return []; }
    }
    , listFontsDetailed: async (): Promise<Array<{ name: string; file?: string; monospace: boolean }>> => {
      try {
        const res = await ipcRenderer.invoke('utils.listFontsDetailed');
        if (res && res.ok && Array.isArray(res.fonts)) return res.fonts as Array<{ name: string; file?: string; monospace: boolean }>;
        return [];
      } catch { return []; }
    }
    , detectPwsh: async (): Promise<{ ok: boolean; available?: boolean; path?: string; error?: string }> => {
      try { return await ipcRenderer.invoke('utils.detectPwsh'); } catch (e: any) { return { ok: false, available: false, error: String(e) }; }
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
