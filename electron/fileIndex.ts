// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { app, BrowserWindow } from "electron";
import { getDebugConfig } from "./debugConfig";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { perfLogger } from "./log";
import chokidar, { FSWatcher } from "chokidar";

// 与扫描/监听一致的默认排除规则（目录前缀，统一使用 "/" 分隔）
const DEFAULT_EXCLUDES = [
  ".git/", "node_modules/", "dist/", "build/", "out/", ".next/", ".cache/",
  "target/", ".idea/", ".vscode/", "coverage/", "tmp/", "temp/",
];

// 文件/目录候选类型（相对路径，分隔符统一为 "/"）
export type FileCandidate = { rel: string; isDir: boolean };

type DiskCache = {
  root: string;
  excludes: string[];
  updatedAt: number;
  files: string[]; // 相对路径，"/" 分隔
  dirs: string[];  // 相对路径，"/" 分隔
};

type MemEntry = {
  root: string; // 原始 Windows/UNC 根
  excludes: string[];
  updatedAt: number;
  files: string[];
  dirs: string[];
};

const MAX_MEM_ENTRIES = 3; // 简易 LRU 上限：主动收敛缓存规模，避免大仓库常驻占用
const memLRU: Map<string, MemEntry> = new Map(); // key -> entry（插入顺序即 LRU）

// 调试与日志开关：环境变量 CODEX_FILEINDEX_DEBUG=1 或在 userData 放置 fileindex-debug.on 文件
function dbgEnabled(): boolean {
  try { return !!getDebugConfig().fileIndex.debug; } catch { return false; }
}
function logDbg(msg: string) { try { if (dbgEnabled()) perfLogger.log(`[fileIndex] ${msg}`); } catch {} }

function getUserDataDir(): string {
  try { return app.getPath("userData"); } catch { return path.join(process.cwd(), ".userData"); }
}

function cacheDir(): string { return path.join(getUserDataDir(), "file-index"); }

function ensureDirSync(p: string) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function canonKey(root: string): string {
  // 作为缓存 key：仅用于区分目录，统一大小写/分隔符
  const s = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  // 使用 sha1 避免路径过长导致文件名超限
  return crypto.createHash("sha1").update(s).digest("hex");
}

function diskPathFor(root: string): string {
  return path.join(cacheDir(), `${canonKey(root)}.json`);
}

function toPosix(p: string): string { return String(p || "").replace(/\\/g, "/"); }

function normRel(p: string): string { return toPosix(p).replace(/^\/+/, "").replace(/\/+/g, "/"); }

function pushLRU(key: string, entry: MemEntry) {
  // 维护 LRU：更新即刷新顺序
  if (memLRU.has(key)) memLRU.delete(key);
  memLRU.set(key, entry);
  if (memLRU.size > MAX_MEM_ENTRIES) {
    const firstKey = memLRU.keys().next().value as string | undefined;
    if (firstKey) {
      memLRU.delete(firstKey);
      // 若对应 watcher 存在，则关闭以释放资源
      try { stopWatcherByKey(firstKey); } catch {}
    }
  }
}

function findRipgrep(): string[] {
  // 优先顺序：vendor/bin → 环境变量 → resources/bin → 开发态 build/bin & bin → PATH
  const cands: string[] = [];
  try {
    cands.push(path.join(process.cwd(), 'vendor', 'bin', 'rg.exe'));
    cands.push(path.join(process.cwd(), 'vendor', 'bin', 'rg'));
  } catch {}
  const envPath = String(process.env.RIPGREP_PATH || '').trim();
  if (envPath) cands.push(envPath);
  try {
    const p1 = path.join(process.resourcesPath || '', 'bin', 'rg.exe');
    const p2 = path.join(process.resourcesPath || '', 'bin', 'rg');
    cands.push(p1, p2);
  } catch {}
  try {
    // 开发态：项目内置路径（如 build/bin/rg.exe 或 bin/rg.exe）
    cands.push(path.join(process.cwd(), 'build', 'bin', 'rg.exe'));
    cands.push(path.join(process.cwd(), 'build', 'bin', 'rg'));
    cands.push(path.join(process.cwd(), 'bin', 'rg.exe'));
    cands.push(path.join(process.cwd(), 'bin', 'rg'));
  } catch {}
  cands.push('rg', 'rg.exe');
  return cands.filter(Boolean);
}

async function scanWithRipgrep(root: string, excludes?: string[]): Promise<{ files: string[]; dirs: string[] }> {
  const t0 = Date.now();
  const ex: string[] = Array.from(new Set([ ...DEFAULT_EXCLUDES, ...(excludes || []) ]));
  const args: string[] = [
    "--files",
    "--hidden",
    "--follow",
    "--path-separator",
    "/",
  ];
  for (const e of ex) {
    // ripgrep glob 需使用 / 分隔，排除前缀目录
    const pat = String(e).replace(/\\/g, "/");
    args.push("-g"); args.push(`!${pat}`);
  }

  // UNC 根目录在部分 Windows API 下无法作为 cwd 使用，这里对 UNC 采用“作为显式路径参数”策略
  const isUNC = /^\\\\/.test(root);
  const useCwd = !isUNC; // 盘符路径可用 cwd；UNC 作为参数传入
  if (!useCwd) args.push(root);

  let usedBin = '';
  const attempts: string[] = [];
  const stdout = await new Promise<string>((resolve, reject) => {
    try {
      const bins = findRipgrep();
      const tryNext = (idx: number) => {
        if (idx >= bins.length) { reject(new Error('ripgrep not found')); return; }
        const bin = bins[idx];
        attempts.push(bin);
        const opts: any = { windowsHide: true, shell: false, timeout: 1000 * 60 * 10, maxBuffer: 1024 * 1024 * 256 };
        if (useCwd) (opts as any).cwd = root;
        execFile(bin, args, opts, (err, out, _errOut) => {
          if (err) { tryNext(idx + 1); return; }
          usedBin = bin;
          resolve(String(out || ''));
        });
      };
      tryNext(0);
    } catch (e) { reject(e); }
  });

  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const files: string[] = [];
  let skippedOutside = 0;
  for (const line of lines) {
    if (!line) continue;
    if (useCwd) {
      files.push(normRel(line));
    } else {
      // 回传的是绝对路径：转换为相对 root
      try {
        const absWin = String(line).replace(/\//g, "\\");
        const rootWin = String(root).replace(/\//g, "\\");
        let rel = path.win32.relative(rootWin, absWin);
        if (!rel || rel.startsWith('..')) { skippedOutside++; continue; } // 非根子路径，跳过
        rel = rel.replace(/\\/g, '/');
        files.push(normRel(rel));
      } catch { /* skip */ }
    }
  }
  const dirsSet = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (d) dirsSet.add(d);
    }
  }
  const dirs = Array.from(dirsSet);
  const dur = Date.now() - t0;
  logDbg(`scan done root='${root}' unc=${isUNC} cwdMode=${useCwd} bin='${usedBin}' attempts=${attempts.length} files=${files.length} dirs=${dirs.length} skippedOutside=${skippedOutside} dur=${dur}ms args=${JSON.stringify(args)}`);
  return { files, dirs };
}

async function loadFromDisk(root: string): Promise<MemEntry | null> {
  try {
    const p = diskPathFor(root);
    const buf = await fsp.readFile(p, "utf8");
    const json = JSON.parse(buf) as DiskCache;
    if (!json || !Array.isArray(json.files) || !Array.isArray(json.dirs)) return null;
    logDbg(`cache.disk.hit root='${root}' file='${p}' files=${json.files.length} dirs=${json.dirs.length} updatedAt=${json.updatedAt}`);
    return { root, excludes: json.excludes || [], updatedAt: json.updatedAt || Date.now(), files: json.files, dirs: json.dirs };
  } catch { return null; }
}

async function saveToDisk(root: string, data: MemEntry) {
  try {
    ensureDirSync(cacheDir());
    const p = diskPathFor(root);
    const payload: DiskCache = { root, excludes: data.excludes || [], updatedAt: data.updatedAt || Date.now(), files: data.files || [], dirs: data.dirs || [] };
    await fsp.writeFile(p, JSON.stringify(payload), "utf8");
    logDbg(`cache.disk.save root='${root}' file='${p}' files=${payload.files.length} dirs=${payload.dirs.length}`);
  } catch {}
}

export async function ensureIndex(args: { root: string; excludes?: string[] }): Promise<{ total: number; updatedAt: number }> {
  const root = String(args?.root || "").trim();
  if (!root) throw new Error("root is required");
  const key = canonKey(root);
  // 命中内存
  const hit = memLRU.get(key);
  if (hit) {
    // 确保内存条目携带完整排除（默认 + 传入）
    try {
      const eff = Array.from(new Set([ ...(hit.excludes || []), ...(args?.excludes || []), ...DEFAULT_EXCLUDES ]));
      hit.excludes = eff;
    } catch {}
    pushLRU(key, hit);
    logDbg(`cache.mem.hit root='${root}' files=${hit.files.length} dirs=${hit.dirs.length}`);
    // 确保监听已建立（避免仅首次扫描才建监听）
    try { ensureWatcher(root, hit.excludes || []); } catch {}
    return { total: hit.files.length + hit.dirs.length, updatedAt: hit.updatedAt };
  }
  // 命中磁盘
  const disk = await loadFromDisk(root);
  if (disk) {
    // 合并排除：磁盘缓存 + 传入 + 默认
    const eff = Array.from(new Set([ ...(disk.excludes || []), ...(args?.excludes || []), ...DEFAULT_EXCLUDES ]));
    const merged = { ...disk, excludes: eff } as MemEntry;
    pushLRU(key, merged);
    try { ensureWatcher(root, eff); } catch {}
    return { total: merged.files.length + merged.dirs.length, updatedAt: merged.updatedAt };
  }
  // 扫描并写盘 + 入内存
  logDbg(`scan.start root='${root}' excludes=${JSON.stringify(args?.excludes || [])}`);
  const effectiveExcludes = Array.from(new Set([ ...(args?.excludes || []), ...DEFAULT_EXCLUDES ]));
  const { files, dirs } = await perfLogger.time("fileIndex.scan", () => scanWithRipgrep(root, effectiveExcludes));
  const entry: MemEntry = { root, excludes: effectiveExcludes, updatedAt: Date.now(), files, dirs };
  pushLRU(key, entry);
  try { await saveToDisk(root, entry); } catch {}
  logDbg(`scan.done root='${root}' files=${files.length} dirs=${dirs.length}`);
  try { ensureWatcher(root, effectiveExcludes); } catch {}
  return { total: files.length + dirs.length, updatedAt: entry.updatedAt };
}

export function getAllCandidates(root: string): FileCandidate[] {
  const key = canonKey(root);
  const hit = memLRU.get(key);
  logDbg(`candidates.get root='${root}' hit=${!!hit} files=${hit?.files.length || 0} dirs=${hit?.dirs.length || 0}`);
  if (!hit) return [];
  // 统一输出 { rel, isDir }
  const items: FileCandidate[] = [];
  for (const d of hit.dirs) items.push({ rel: d, isDir: true });
  for (const f of hit.files) items.push({ rel: f, isDir: false });
  return items;
}

export default { ensureIndex, getAllCandidates, setActiveRoots };

// ---------------- 变更监听与热更新 ----------------

type WatchState = {
  watcher: FSWatcher;
  root: string;
  excludes: string[];
  filesSet: Set<string>;
  dirsSet: Set<string>;
  // 防抖刷盘/通知
  notifyTimer?: NodeJS.Timeout;
  saveTimer?: NodeJS.Timeout;
  // 事件与兜底重扫
  lastEventTs?: number;
  rescanTimer?: NodeJS.Timeout;
  // 增量下发控制：记录上次已下发的快照
  lastSentFiles?: Set<string>;
  lastSentDirs?: Set<string>;
  lastSaveAt?: number;
};

const watchers: Map<string, WatchState> = new Map(); // key -> state

function stopWatcherByKey(key: string) {
  try {
    const st = watchers.get(key);
    if (!st) return;
    try { st.watcher && (st.watcher as any).close?.(); } catch {}
    try { if (st.notifyTimer) clearTimeout(st.notifyTimer); } catch {}
    try { if (st.saveTimer) clearTimeout(st.saveTimer); } catch {}
    try { if (st.rescanTimer) clearInterval(st.rescanTimer); } catch {}
    watchers.delete(key);
    logDbg(`watch.stop key='${key}' byStop`);
  } catch {}
}

export function setActiveRoots(activeRoots: string[]): { closed: number; remain: number; trimmed: number } {
  try {
    const allowed = new Set<string>((activeRoots || []).map((r) => canonKey(String(r || ''))));
    let closed = 0;
    for (const [key] of Array.from(watchers.entries())) {
      if (!allowed.has(key)) {
        try { stopWatcherByKey(key); closed++; } catch {}
      }
    }
    // 同步收敛内存缓存：仅保留当前活跃根对应的条目，避免历史大仓库长期驻留
    let trimmed = 0;
    for (const key of Array.from(memLRU.keys())) {
      if (allowed.has(key)) continue;
      memLRU.delete(key);
      trimmed++;
    }
    if (trimmed > 0) logDbg(`cache.mem.trim active=${allowed.size} trimmed=${trimmed} remain=${memLRU.size}`);
    return { closed, remain: watchers.size, trimmed };
  } catch { return { closed: 0, remain: watchers.size, trimmed: 0 }; }
}

function toPosixAbs(p: string): string { return String(p || '').replace(/\\/g, '/'); }

function shouldIgnoreRel(rel: string, excludes: string[]): boolean {
  // 仅做目录前缀/段匹配，保持与 scan 的常见排除（.git、node_modules 等）一致
  try {
    const r = rel.replace(/\\/g, '/');
    for (const e of excludes || []) {
      const ee = String(e || '').replace(/\\/g, '/');
      const seg = ee.replace(/\/$/, '');
      if (!seg) continue;
      if (r === seg || r.startsWith(seg + '/') || r.includes('/' + seg + '/')) return true;
    }
  } catch {}
  return false;
}

function normDriveCase(p: string): string {
  try { return p.replace(/^([A-Za-z]):(\\|\/)/, (_m, d, sep) => `${String(d).toLowerCase()}:${sep}`); } catch { return p; }
}

function relFromAbs(root: string, abs: string): string | null {
  try {
    // 统一分隔符与盘符大小写
    let absWin = normDriveCase(String(abs).replace(/\//g, "\\"));
    let rootWin = normDriveCase(String(root).replace(/\//g, "\\"));
    // 不同盘符：直接视为根外
    const dA = absWin.slice(0, 2);
    const dR = rootWin.slice(0, 2);
    if (/^[a-zA-Z]:$/.test(dA) && /^[a-zA-Z]:$/.test(dR) && dA.toLowerCase() !== dR.toLowerCase()) return null;
    let rel = path.win32.relative(rootWin, absWin);
    if (rel === '') return '';
    // 若 relative 返回绝对路径或 .. 开头，视为根外
    if (!rel || rel.startsWith('..') || path.win32.isAbsolute(rel)) return null;
    return normRel(rel.replace(/\\/g, '/'));
  } catch { return null; }
}

function addDirsForPath(dirsSet: Set<string>, relPath: string) {
  const parts = relPath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    if (d) dirsSet.add(d);
  }
}

function notifyRenderer(root: string, reason: string, patch?: { adds?: { rel: string; isDir: boolean }[]; removes?: { rel: string; isDir: boolean }[] }) {
  try {
    try {
      const extra = patch ? ` adds=${patch.adds?.length || 0} removes=${patch.removes?.length || 0}` : '';
      perfLogger.log(`[fileIndex] notify root='${root}' reason='${reason}'${extra}`);
    } catch {}
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      try { w.webContents.send('fileIndex:changed', { root, reason, adds: patch?.adds || [], removes: patch?.removes || [] }); } catch {}
    }
  } catch {}
}

const SAVE_MIN_INTERVAL_MS = 4000;

function scheduleFlush(state: WatchState) {
  // 合并频繁事件：100ms 通知，800ms 落盘
  try { if (state.notifyTimer) clearTimeout(state.notifyTimer); } catch {}
  try { if (state.saveTimer) clearTimeout(state.saveTimer); } catch {}
  state.notifyTimer = setTimeout(() => {
    // 计算增量补丁：基于上次已下发的快照
    try {
      if (!state.lastSentFiles) state.lastSentFiles = new Set<string>();
      if (!state.lastSentDirs) state.lastSentDirs = new Set<string>();
      const adds: { rel: string; isDir: boolean }[] = [];
      const removes: { rel: string; isDir: boolean }[] = [];
      // 文件增删
      for (const f of state.filesSet) { if (!state.lastSentFiles.has(f)) adds.push({ rel: f, isDir: false }); }
      for (const f of Array.from(state.lastSentFiles)) { if (!state.filesSet.has(f)) removes.push({ rel: f, isDir: false }); }
      // 目录增删
      for (const d of state.dirsSet) { if (!state.lastSentDirs.has(d)) adds.push({ rel: d, isDir: true }); }
      for (const d of Array.from(state.lastSentDirs)) { if (!state.dirsSet.has(d)) removes.push({ rel: d, isDir: true }); }
      // 更新快照
      state.lastSentFiles = new Set(state.filesSet);
      state.lastSentDirs = new Set(state.dirsSet);
      // 仅当存在变更时通知
      if (adds.length > 0 || removes.length > 0) notifyRenderer(state.root, 'fs', { adds, removes });
    } catch { notifyRenderer(state.root, 'fs'); }
  }, 120);
  state.saveTimer = setTimeout(async () => {
    try {
      const key = canonKey(state.root);
      const entry = memLRU.get(key);
      if (entry) {
        entry.files = Array.from(state.filesSet);
        entry.dirs = Array.from(state.dirsSet);
        entry.updatedAt = Date.now();
        // 写盘限流：避免大仓库频繁 stringify 阻塞主线程
        const now = Date.now();
        const shouldSave = !state.lastSaveAt || (now - state.lastSaveAt) >= SAVE_MIN_INTERVAL_MS;
        if (shouldSave) { await saveToDisk(state.root, entry); state.lastSaveAt = now; }
      }
    } catch {}
  }, 800);
}

function numEnv(name: string, def: number): number { const v = Number(String((process as any).env[name] || '').trim() || ''); return Number.isFinite(v) && v > 0 ? v : def; }

function ensureWatcher(root: string, excludes: string[]) {
  const key = canonKey(root);
  if (watchers.has(key)) return; // 已建立
  // 需要依赖已有内存条目（来自 ensureIndex / 磁盘加载）
  const entry = memLRU.get(key);
  if (!entry) return;
  // 初始化可变集合（与内存条目同步）
  const filesSet = new Set<string>(entry.files || []);
  const dirsSet = new Set<string>(entry.dirs || []);

  // 生成本地与 POSIX 风格的 glob，提升兼容性（对网络盘/UNC 更友好）
  const globs: string[] = [];
  try {
    globs.push(path.join(root, '**', '*'));
    const posix = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/**/*';
    globs.push(posix);
  } catch { globs.push(root); }

  // chokidar 监听；UNC/盘符均尝试；若失败不会影响基础功能
  const isUNC = /^\\\\/.test(root);
  const cfg = (() => { try { return getDebugConfig(); } catch { return null as any; } })();
  const wantPollingCfg = !!(cfg && cfg.fileIndex && cfg.fileIndex.poll && cfg.fileIndex.poll.enable);
  const wantPolling = wantPollingCfg || isUNC; // UNC 默认轮询更稳
  const intervalCfg = Number((cfg && cfg.fileIndex && cfg.fileIndex.poll && (cfg.fileIndex.poll as any).intervalMs) || 0);
  const interval = intervalCfg > 0 ? intervalCfg : (isUNC ? 2500 : 1200);
  const binInterval = Math.max(interval * 1.5, isUNC ? 4000 : 1500);

  // 大仓库策略：超阈值则跳过 watcher，仅启用周期重扫；中等规模降低 depth
  const DISABLE_WATCH = !!(cfg && cfg.fileIndex && cfg.fileIndex.watch && cfg.fileIndex.watch.disable);
  const MAX_FILES = cfg?.fileIndex?.watch?.maxFiles ?? numEnv('CODEX_FILEINDEX_WATCH_MAX_FILES', 80000);
  const MAX_DIRS = cfg?.fileIndex?.watch?.maxDirs ?? numEnv('CODEX_FILEINDEX_WATCH_MAX_DIRS', 12000);
  const LARGE_FILES = cfg?.fileIndex?.watch?.maxFiles ? Math.floor((cfg.fileIndex.watch.maxFiles as number) / 2) : numEnv('CODEX_FILEINDEX_WATCH_LARGE_FILES', 40000);
  const LARGE_DIRS = cfg?.fileIndex?.watch?.maxDirs ? Math.floor((cfg.fileIndex.watch.maxDirs as number) / 2) : numEnv('CODEX_FILEINDEX_WATCH_LARGE_DIRS', 6000);
  const DEPTH_DEFAULT = ((): number => { const d = cfg?.fileIndex?.watch?.depth; if (typeof d === 'number') return d; return numEnv('CODEX_FILEINDEX_WATCH_DEPTH', 6); })();
  const DEPTH_LARGE = numEnv('CODEX_FILEINDEX_WATCH_DEPTH_LARGE', 2);
  const totalFiles = filesSet.size;
  const totalDirs = dirsSet.size;
  const overMax = DISABLE_WATCH || totalFiles > MAX_FILES || totalDirs > MAX_DIRS;
  const isLarge = !overMax && (totalFiles > LARGE_FILES || totalDirs > LARGE_DIRS);

  if (overMax) {
    // 跳过 watcher，改为更频繁的周期重扫（异步，不阻塞主线程）
    const state: WatchState = { watcher: null as any, root, excludes: excludes || [], filesSet, dirsSet } as any;
    watchers.set(key, state);
    try { perfLogger.log(`[fileIndex] watch.skip root='${root}' files=${totalFiles} dirs=${totalDirs}`); } catch {}
    // 强制开启兜底重扫
    try {
      state.lastEventTs = Date.now();
      const cfg2 = (() => { try { return getDebugConfig(); } catch { return null as any; } })();
      const idleMs = Number(cfg2?.fileIndex?.rescan?.idleMs ?? 10000);
      const rescanEvery = Number(cfg2?.fileIndex?.rescan?.intervalMs ?? 15000);
      state.rescanTimer = setInterval(async () => {
        try {
          if (!state.lastEventTs || (Date.now() - state.lastEventTs) < idleMs) return;
          const effEx = state.excludes && state.excludes.length > 0 ? state.excludes : (entry.excludes || DEFAULT_EXCLUDES);
          const { files, dirs } = await scanWithRipgrep(root, effEx);
          const before = state.filesSet; const current = new Set(files);
          let changed = false;
          for (const f of current) { if (!before.has(f)) { before.add(f); addDirsForPath(state.dirsSet, f); changed = true; } }
          for (const f of Array.from(before)) { if (!current.has(f)) { before.delete(f); changed = true; } }
          if (changed) scheduleFlush(state);
        } catch {}
      }, rescanEvery);
    } catch {}
    return;
  }
  const watcher = chokidar.watch(globs, {
    persistent: true,
    ignoreInitial: true,
    disableGlobbing: false,
    usePolling: wantPolling,
    interval: interval,
    binaryInterval: binInterval,
    ignored: (p: string) => {
      try {
        const rel = relFromAbs(root, p);
        if (rel === null) return true; // 非根子路径，忽略
        // 注意：rel 可能为 ''（即根目录本身），此时不能忽略
        return shouldIgnoreRel(rel, excludes.length > 0 ? excludes : (entry.excludes || []));
      } catch { return false; }
    },
    awaitWriteFinish: isLarge ? undefined : { stabilityThreshold: 200, pollInterval: 50 },
    ignorePermissionErrors: true,
    depth: isLarge ? DEPTH_LARGE : DEPTH_DEFAULT,
  });

  const state: WatchState = { watcher, root, excludes: excludes || [], filesSet, dirsSet };
  watchers.set(key, state);
  logDbg(`watch.start root='${root}'`);
  try { perfLogger.log(`[fileIndex] watch.start root='${root}'`); } catch {}

  const onAdd = (abs: string) => {
    const rel = relFromAbs(root, abs);
    if (!rel) return;
    if (shouldIgnoreRel(rel, state.excludes.length > 0 ? state.excludes : entry.excludes)) return;
    logDbg(`watch.add root='${root}' rel='${rel}'`);
    try { state.lastEventTs = Date.now(); } catch {}
    if (!state.filesSet.has(rel)) {
      state.filesSet.add(rel);
      addDirsForPath(state.dirsSet, rel);
      // 立即同步到内存条目，保证渲染端 getAllCandidates 立刻可见
      try {
        const e = memLRU.get(key);
        if (e) {
          if (!e.files.includes(rel)) e.files.push(rel);
          // 确保目录也同步
          const newDirs: string[] = [];
          const parts = rel.split('/');
          for (let i = 1; i < parts.length; i++) {
            const d = parts.slice(0, i).join('/');
            if (d && !e.dirs.includes(d)) newDirs.push(d);
          }
          if (newDirs.length > 0) e.dirs.push(...newDirs);
          e.updatedAt = Date.now();
        }
      } catch {}
      scheduleFlush(state);
    }
  };
  const onUnlink = (abs: string) => {
    const rel = relFromAbs(root, abs);
    if (!rel) return;
    logDbg(`watch.unlink root='${root}' rel='${rel}'`);
    try { state.lastEventTs = Date.now(); } catch {}
    if (state.filesSet.delete(rel)) {
      try {
        const e = memLRU.get(key);
        if (e) {
          const i = e.files.indexOf(rel);
          if (i >= 0) e.files.splice(i, 1);
          e.updatedAt = Date.now();
        }
      } catch {}
      scheduleFlush(state);
    }
  };
  const onAddDir = (abs: string) => {
    const rel = relFromAbs(root, abs);
    if (!rel) return;
    logDbg(`watch.addDir root='${root}' rel='${rel}'`);
    try { state.lastEventTs = Date.now(); } catch {}
    if (!state.dirsSet.has(rel)) {
      state.dirsSet.add(rel);
      try { const e = memLRU.get(key); if (e && !e.dirs.includes(rel)) { e.dirs.push(rel); e.updatedAt = Date.now(); } } catch {}
      scheduleFlush(state);
    }
  };
  const onUnlinkDir = (abs: string) => {
    const rel = relFromAbs(root, abs);
    if (!rel) return;
    logDbg(`watch.unlinkDir root='${root}' rel='${rel}'`);
    try { state.lastEventTs = Date.now(); } catch {}
    if (state.dirsSet.delete(rel)) {
      try { const e = memLRU.get(key); if (e) { const i = e.dirs.indexOf(rel); if (i >= 0) e.dirs.splice(i, 1); e.updatedAt = Date.now(); } } catch {}
      scheduleFlush(state);
    }
  };

  watcher.on('add', onAdd);
  watcher.on('change', (abs: string) => {
    // 兜底：若之前错过 add 事件，收到 change 时补入
    try {
      const rel = relFromAbs(root, abs);
      if (!rel) return;
      if (shouldIgnoreRel(rel, state.excludes.length > 0 ? state.excludes : entry.excludes)) return;
      if (!state.filesSet.has(rel)) onAdd(abs);
    } catch {}
  });
  watcher.on('unlink', onUnlink);
  watcher.on('addDir', onAddDir);
  watcher.on('unlinkDir', onUnlinkDir);
  watcher.on('error', (e) => { try { perfLogger.log(`[fileIndex] watch.error root='${root}' err=${String(e)}`); } catch {} });
  watcher.on('ready', () => { try { perfLogger.log(`[fileIndex] watch.ready root='${root}' polling=${wantPolling} interval=${interval}`); } catch {} });

  // —— 空闲兜底重扫：避免偶发漏报 ——
  try {
    state.lastEventTs = Date.now();
    const idleMs = Number(cfg?.fileIndex?.rescan?.idleMs ?? 20000);
    const rescanEvery = Number(cfg?.fileIndex?.rescan?.intervalMs ?? (wantPolling ? 0 : (isUNC ? 0 : 30000)));
    if (rescanEvery > 0) {
      state.rescanTimer = setInterval(async () => {
        try {
          if (!state.lastEventTs || (Date.now() - state.lastEventTs) < idleMs) return;
          const effEx = state.excludes && state.excludes.length > 0 ? state.excludes : (entry.excludes || DEFAULT_EXCLUDES);
          const { files, dirs } = await scanWithRipgrep(root, effEx);
          const before = state.filesSet;
          const current = new Set(files);
          let changed = false;
          // 新增
          for (const f of current) {
            if (!before.has(f)) { before.add(f); addDirsForPath(state.dirsSet, f); changed = true; }
          }
          // 删除
          for (const f of Array.from(before)) {
            if (!current.has(f)) { before.delete(f); changed = true; }
          }
          if (changed) scheduleFlush(state);
        } catch {}
      }, rescanEvery);
    }
  } catch {}
}
