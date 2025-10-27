// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { perfLogger } from "./log";

// 统一调试配置：单文件 JSONC（支持注释），集中替代环境变量/localStorage/flag 文件

export type DebugConfig = {
  version: number;
  global: {
    diagLog: boolean;          // 主/渲染进程诊断日志（写入 perf.log）
    openDevtools: boolean;     // 启动时强制打开 DevTools
  };
  renderer: {
    uiDebug: boolean;          // UI 交互/遮罩诊断
    notifications: {
      debug: boolean;          // 通知附加日志
      menu: "auto" | "forceOn" | "forceOff"; // 右键调试菜单
    };
    atSearchDebug: boolean;    // @ 搜索调试
  };
  terminal: {
    frontend: { debug: boolean; disablePin: boolean }; // 渲染层终端日志/禁用钉行
    pty: { debug: boolean };                            // 主进程 PTY 日志
  };
  fileIndex: {
    debug: boolean;
    poll: { enable: boolean; intervalMs: number };
    watch: {
      disable: boolean;
      maxFiles: number;
      maxDirs: number;
      depth: number | "auto";
    };
    rescan: { idleMs: number; intervalMs: number };
  };
  history: { debug: boolean; filter: string };
  indexer: { debug: boolean; filter: string };
  projects: { debug: boolean };
  updates: { skipVersion: string };
  codex: { tuiTrace: boolean };
};

let cached: DebugConfig | null = null;
let lastMtime = 0;
const listeners = new Set<(cfg: DebugConfig) => void>();

function getConfigPath(): string { return path.join(app.getPath("userData"), "debug.config.jsonc"); }

function stripJsonComments(input: string): string {
  try {
    const src = String(input || "");
    let out = "";
    let inString = false;
    let quoteChar = "";
    let escaped = false;
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (inString) {
        out += ch;
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quoteChar) {
          inString = false;
          quoteChar = "";
        }
        i += 1;
        continue;
      }

      if (ch === '"' || ch === '\'') {
        inString = true;
        quoteChar = ch;
        out += ch;
        i += 1;
        continue;
      }

      if (ch === '/' && i + 1 < src.length) {
        const next = src[i + 1];
        if (next === '/') {
          // 跳过单行注释
          i += 2;
          while (i < src.length && src[i] !== '\n' && src[i] !== '\r') {
            i += 1;
          }
          continue;
        }
        if (next === '*') {
          // 跳过多行注释
          i += 2;
          while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) {
            i += 1;
          }
          if (i < src.length - 1) {
            i += 2; // 跳过结束 */
          }
          continue;
        }
      }

      out += ch;
      i += 1;
    }
    return out;
  } catch {
    return input;
  }
}

export function getDefaultDebugConfig(): DebugConfig {
  return {
    version: 1,
    global: { diagLog: false, openDevtools: false },
    renderer: { uiDebug: false, notifications: { debug: false, menu: "auto" }, atSearchDebug: false },
    terminal: { frontend: { debug: false, disablePin: false }, pty: { debug: false } },
    fileIndex: {
      debug: false,
      poll: { enable: false, intervalMs: 1000 },
      watch: { disable: false, maxFiles: 100000, maxDirs: 50000, depth: "auto" },
      rescan: { idleMs: 20000, intervalMs: 30000 }
    },
    history: { debug: false, filter: "" },
    indexer: { debug: false, filter: "" },
    projects: { debug: false },
    updates: { skipVersion: "" },
    codex: { tuiTrace: false }
  };
}

function renderJsonc(cfg: DebugConfig): string {
  // 生成带注释的 JSONC（稳定顺序），作为唯一权威模板
  const lines: string[] = [];
  lines.push("{");
  lines.push("  \"version\": " + Number(cfg.version || 1) + ",");
  lines.push("  // 全局与日志");
  lines.push("  \"global\": {");
  lines.push("    \"diagLog\": " + (cfg.global.diagLog ? "true" : "false") + ", // 主/渲染进程诊断写 perf.log");
  lines.push("    \"openDevtools\": " + (cfg.global.openDevtools ? "true" : "false") + " // 启动强制打开 DevTools（需重启）");
  lines.push("  },");
  lines.push("  // 渲染层");
  lines.push("  \"renderer\": {");
  lines.push("    \"uiDebug\": " + (cfg.renderer.uiDebug ? "true" : "false") + ", // UI 交互/遮罩诊断");
  lines.push("    \"notifications\": {");
  lines.push("      \"debug\": " + (cfg.renderer.notifications.debug ? "true" : "false") + ", // 通知附加日志");
  lines.push("      \"menu\": \"" + (cfg.renderer.notifications.menu || "auto") + "\" // auto | forceOn | forceOff");
  lines.push("    },");
  lines.push("    \"atSearchDebug\": " + (cfg.renderer.atSearchDebug ? "true" : "false") + " // @ 搜索调试");
  lines.push("  },");
  lines.push("  // 终端");
  lines.push("  \"terminal\": {");
  lines.push("    \"frontend\": { \"debug\": " + (cfg.terminal.frontend.debug ? "true" : "false") + ", \"disablePin\": " + (cfg.terminal.frontend.disablePin ? "true" : "false") + " },");
  lines.push("    \"pty\": { \"debug\": " + (cfg.terminal.pty.debug ? "true" : "false") + " }");
  lines.push("  },");
  lines.push("  // 文件索引");
  lines.push("  \"fileIndex\": {");
  lines.push("    \"debug\": " + (cfg.fileIndex.debug ? "true" : "false") + ",");
  lines.push("    \"poll\": { \"enable\": " + (cfg.fileIndex.poll.enable ? "true" : "false") + ", \"intervalMs\": " + Number(cfg.fileIndex.poll.intervalMs || 1000) + " },");
  lines.push("    \"watch\": { \"disable\": " + (cfg.fileIndex.watch.disable ? "true" : "false") + ", \"maxFiles\": " + Number(cfg.fileIndex.watch.maxFiles || 100000) + ", \"maxDirs\": " + Number(cfg.fileIndex.watch.maxDirs || 50000) + ", \"depth\": " + (typeof cfg.fileIndex.watch.depth === "number" ? String(cfg.fileIndex.watch.depth) : '\"auto\"') + " },");
  lines.push("    \"rescan\": { \"idleMs\": " + Number(cfg.fileIndex.rescan.idleMs || 20000) + ", \"intervalMs\": " + Number(cfg.fileIndex.rescan.intervalMs || 30000) + " }");
  lines.push("  },");
  lines.push("  // 历史与索引器");
  lines.push("  \"history\": { \"debug\": " + (cfg.history.debug ? "true" : "false") + ", \"filter\": \"" + String(cfg.history.filter || "").replace(/\\/g, "\\\\").replace(/\"/g, '\\"') + "\" },");
  lines.push("  \"indexer\": { \"debug\": " + (cfg.indexer.debug ? "true" : "false") + ", \"filter\": \"" + String(cfg.indexer.filter || "").replace(/\\/g, "\\\\").replace(/\"/g, '\\"') + "\" },");
  lines.push("  // 项目扫描");
  lines.push("  \"projects\": { \"debug\": " + (cfg.projects.debug ? "true" : "false") + " },");
  lines.push("  // 更新控制");
  lines.push("  \"updates\": { \"skipVersion\": \"" + String(cfg.updates.skipVersion || "").replace(/\\/g, "\\\\").replace(/\"/g, '\\"') + "\" },");
  lines.push("  // Codex CLI");
  lines.push("  \"codex\": { \"tuiTrace\": " + (cfg.codex.tuiTrace ? "true" : "false") + " }");
  lines.push("}");
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

function merge(a: DebugConfig, b: Partial<DebugConfig> | null | undefined): DebugConfig {
  if (!b) return a;
  const pick = (v: any, def: any) => (typeof v === typeof def ? v : def);
  const x: DebugConfig = getDefaultDebugConfig();
  try { x.version = Number((b as any).version ?? a.version ?? 1); } catch { x.version = a.version; }
  x.global = {
    diagLog: pick((b as any)?.global?.diagLog, a.global.diagLog),
    openDevtools: pick((b as any)?.global?.openDevtools, a.global.openDevtools),
  } as any;
  x.renderer = {
    uiDebug: pick((b as any)?.renderer?.uiDebug, a.renderer.uiDebug),
    notifications: {
      debug: pick((b as any)?.renderer?.notifications?.debug, a.renderer.notifications.debug),
      menu: ((): any => {
        const m = (b as any)?.renderer?.notifications?.menu;
        return m === "forceOn" || m === "forceOff" || m === "auto" ? m : a.renderer.notifications.menu;
      })(),
    },
    atSearchDebug: pick((b as any)?.renderer?.atSearchDebug, a.renderer.atSearchDebug),
  } as any;
  x.terminal = {
    frontend: {
      debug: pick((b as any)?.terminal?.frontend?.debug, a.terminal.frontend.debug),
      disablePin: pick((b as any)?.terminal?.frontend?.disablePin, a.terminal.frontend.disablePin),
    },
    pty: { debug: pick((b as any)?.terminal?.pty?.debug, a.terminal.pty.debug) },
  } as any;
  x.fileIndex = {
    debug: pick((b as any)?.fileIndex?.debug, a.fileIndex.debug),
    poll: {
      enable: pick((b as any)?.fileIndex?.poll?.enable, a.fileIndex.poll.enable),
      intervalMs: Number((b as any)?.fileIndex?.poll?.intervalMs ?? a.fileIndex.poll.intervalMs),
    },
    watch: {
      disable: pick((b as any)?.fileIndex?.watch?.disable, a.fileIndex.watch.disable),
      maxFiles: Number((b as any)?.fileIndex?.watch?.maxFiles ?? a.fileIndex.watch.maxFiles),
      maxDirs: Number((b as any)?.fileIndex?.watch?.maxDirs ?? a.fileIndex.watch.maxDirs),
      depth: ((): any => {
        const v = (b as any)?.fileIndex?.watch?.depth;
        return typeof v === 'number' ? v : (v === 'auto' ? 'auto' : a.fileIndex.watch.depth);
      })(),
    },
    rescan: {
      idleMs: Number((b as any)?.fileIndex?.rescan?.idleMs ?? a.fileIndex.rescan.idleMs),
      intervalMs: Number((b as any)?.fileIndex?.rescan?.intervalMs ?? a.fileIndex.rescan.intervalMs),
    },
  } as any;
  x.history = { debug: pick((b as any)?.history?.debug, a.history.debug), filter: String((b as any)?.history?.filter ?? a.history.filter) };
  x.indexer = { debug: pick((b as any)?.indexer?.debug, a.indexer.debug), filter: String((b as any)?.indexer?.filter ?? a.indexer.filter) };
  x.projects = { debug: pick((b as any)?.projects?.debug, a.projects.debug) };
  x.updates = { skipVersion: String((b as any)?.updates?.skipVersion ?? a.updates.skipVersion) };
  x.codex = { tuiTrace: pick((b as any)?.codex?.tuiTrace, a.codex.tuiTrace) };
  return x;
}

export function readDebugConfig(): DebugConfig {
  try {
    const p = getConfigPath();
    if (!fs.existsSync(p)) {
      const def = getDefaultDebugConfig();
      const text = renderJsonc(def);
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
      fs.writeFileSync(p, text, "utf8");
      cached = def;
      lastMtime = Date.now();
      return def;
    }
    const raw = fs.readFileSync(p, "utf8");
    const json = JSON.parse(stripJsonComments(raw) || "{}") as Partial<DebugConfig>;
    const merged = merge(getDefaultDebugConfig(), json);
    cached = merged;
    try { lastMtime = fs.statSync(p).mtimeMs || Date.now(); } catch { lastMtime = Date.now(); }
    return merged;
  } catch (e) {
    try { perfLogger.log(`[debug.config] read failed: ${String((e as any)?.message || e)}`); } catch {}
    const d = getDefaultDebugConfig();
    cached = d;
    return d;
  }
}

export function getDebugConfig(): DebugConfig {
  if (!cached) return readDebugConfig();
  return cached;
}

export function saveDebugConfig(next: DebugConfig): void {
  try {
    const p = getConfigPath();
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    const text = renderJsonc(next);
    fs.writeFileSync(p, text, "utf8");
    cached = next;
    try { lastMtime = fs.statSync(p).mtimeMs || Date.now(); } catch { lastMtime = Date.now(); }
    notifyChanged();
  } catch (e) {
    try { perfLogger.log(`[debug.config] save failed: ${String((e as any)?.message || e)}`); } catch {}
  }
}

export function updateDebugConfig(partial: Partial<DebugConfig>): DebugConfig {
  const cur = getDebugConfig();
  const next = merge(cur, partial);
  saveDebugConfig(next);
  return next;
}

export function onDebugChanged(handler: (cfg: DebugConfig) => void): () => void {
  listeners.add(handler);
  return () => { try { listeners.delete(handler); } catch {} };
}

function notifyChanged(): void {
  const cfg = getDebugConfig();
  for (const fn of Array.from(listeners)) {
    try { fn(cfg); } catch {}
  }
}

export function watchDebugConfig(): void {
  try {
    const p = getConfigPath();
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    if (!fs.existsSync(p)) { saveDebugConfig(getDebugConfig()); }
    fs.watch(p, { persistent: true }, (_eventType) => {
      try {
        const st = fs.statSync(p);
        if (st && st.mtimeMs && st.mtimeMs !== lastMtime) {
          lastMtime = st.mtimeMs;
          readDebugConfig();
          notifyChanged();
        }
      } catch {}
    });
  } catch {}
}

export function openDebugConfigPath(): string { return getConfigPath(); }

export function resetDebugConfig(): DebugConfig {
  const def = getDefaultDebugConfig();
  saveDebugConfig(def);
  return def;
}


