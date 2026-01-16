// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { app, session, BrowserWindow, webContents } from 'electron';
import type { Session } from 'electron';
import { getBaseUserDataDir } from './featureFlags';

type AppDataInfo = {
  ok: boolean;
  path: string;
  totalBytes: number;
  dirCount: number;
  fileCount: number;
  collectedAt: number;
  error?: string;
};

type ClearOptions = {
  preserveSettings?: boolean;
};

type ClearResult = {
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
};

type AutoProfileDirInfo = {
  profileId: string;
  dirName: string;
  path: string;
  totalBytes: number;
  dirCount: number;
  fileCount: number;
  collectedAt: number;
  isCurrent: boolean;
};

type AutoProfilesInfo = {
  ok: boolean;
  baseUserData: string;
  currentUserData: string;
  count: number;
  totalBytes: number;
  items: AutoProfileDirInfo[];
  error?: string;
};

type PurgeAutoProfilesOptions = {
  includeCurrent?: boolean;
};

type PurgeAutoProfilesResult = {
  ok: boolean;
  total: number;
  removed: number;
  skipped: number;
  busy: number;
  notFound: number;
  bytesFreed: number;
  errors?: Array<{ profileId: string; path: string; message: string }>;
  error?: string;
};

const SETTINGS_FILE = 'settings.json';
const KNOWN_LOCK_NAMES = new Set<string>(['lockfile', 'SingletonLock', 'LOCK', 'LOCKFILE']);
const RETRIABLE_ERROR_CODES = new Set<string>(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const BUSY_ERROR_KEYWORDS = [
  'busy',
  'locked',
  'being used by another process',
  'access is denied',
  'operation not permitted',
  'permission denied',
];
function getUserDataPath(): string {
  try {
    return app.getPath('userData');
  } catch {
    return path.join(process.cwd(), 'userData');
  }
}

/**
 * 获取基础 userData 目录（跨 profile 共用），用于扫描 profile 子目录。
 */
function getBaseUserDataPath(): string {
  const fallback = getUserDataPath();
  const fromEnv = (() => {
    try { return String(process.env.CODEXFLOW_BASE_USERDATA || '').trim(); } catch { return ''; }
  })();
  const base = (() => {
    try { return String(getBaseUserDataDir() || '').trim(); } catch { return ''; }
  })();
  const candidate = fromEnv || base || fallback;
  try {
    const name = path.basename(candidate);
    const marker = '-profile-';
    const idx = name.indexOf(marker);
    if (idx > 0) {
      const stripped = name.slice(0, idx);
      if (stripped) return path.join(path.dirname(candidate), stripped);
    }
  } catch {}
  return candidate;
}

/**
 * 将路径归一化成用于比较的 key（忽略分隔符与大小写差异）。
 */
function normalizePathKey(p: string): string {
  try {
    return String(p || '').replace(/[\\/]+/g, '/').toLowerCase();
  } catch {
    return '';
  }
}

async function ensureDir(root: string): Promise<void> {
  try {
    await fsp.mkdir(root, { recursive: true });
  } catch {}
}

async function safeReaddir(dirPath: string) {
  try {
    return await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [] as fs.Dirent[];
  }
}

async function safeStat(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(filePath);
  } catch {
    return null;
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushElectronSessions() {
  const collected: Session[] = [];
  try {
    const def = session.defaultSession;
    if (def) collected.push(def);
  } catch {}
  try {
    const getAll = (session as any).getAllSessions;
    if (typeof getAll === 'function') {
      const others = getAll();
      if (Array.isArray(others)) {
        for (const s of others) {
          if (s && !collected.includes(s)) collected.push(s);
        }
      }
    }
  } catch {}
  for (const s of collected) {
    try {
      if (typeof s.clearCache === 'function') await s.clearCache();
    } catch {}
    try {
      const anySession = s as unknown as { clearCodeCaches?: () => Promise<void>; clearHostResolverCache?: () => Promise<void>; clearAuthCache?: (opts: any) => Promise<void>; clearStorageData?: (opts?: any) => Promise<void> };
      if (typeof anySession.clearCodeCaches === 'function') await anySession.clearCodeCaches();
      if (typeof anySession.clearHostResolverCache === 'function') await anySession.clearHostResolverCache();
      if (typeof anySession.clearAuthCache === 'function') await anySession.clearAuthCache({});
      if (typeof anySession.clearStorageData === 'function') await anySession.clearStorageData({});
    } catch {}
  }
  if (collected.length > 0) {
    await sleep(80);
  }
}

async function prePurgeSessions() {
  const bag = new Set<Session>();
  try {
    const all = webContents.getAllWebContents();
    for (const wc of all) {
      try {
        if (wc?.session) bag.add(wc.session);
      } catch {}
    }
  } catch {}
  try {
    const def = session.defaultSession;
    if (def) bag.add(def);
  } catch {}
  for (const s of bag) {
    if (!s) continue;
    try { await s.flushStorageData?.(); } catch {}
    try {
      const clearStorage = s.clearStorageData?.bind(s);
      if (typeof clearStorage === 'function') {
        await clearStorage({
          storages: [
            'appcache',
            'cookies',
            'filesystem',
            'indexdb',
            'localstorage',
            'shadercache',
            'websql',
            'serviceworkers',
            'cachestorage',
            'trustTokens',
          ],
          quotas: ['persistent', 'temporary', 'syncable'],
        } as any);
      }
    } catch {}
    try { await s.clearCodeCaches?.({}); } catch {}
    try { await s.clearCache(); } catch {}
    try { await s.closeAllConnections?.(); } catch {}
  }
  await sleep(60);
}

function classifyFsError(err: unknown): 'missing' | 'busy' | 'fatal' {
  const code = typeof (err as any)?.code === 'string' ? String((err as any).code) : '';
  if (code === 'ENOENT') return 'missing';
  if (RETRIABLE_ERROR_CODES.has(code)) return 'busy';
  const message = typeof (err as any)?.message === 'string' ? String((err as any).message).toLowerCase() : '';
  if (message) {
    if (message.includes('enoent')) return 'missing';
    for (const kw of BUSY_ERROR_KEYWORDS) {
      if (message.includes(kw)) return 'busy';
    }
  }
  return 'fatal';
}

function formatFsError(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function makeTempName(base: string): string {
  const safe = base.replace(/[\\/:*?"<>|]/g, '_');
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return `${safe || 'entry'}.tmp-${suffix}`;
}

/**
 * 扫描并返回 auto-* profile 的 userData 目录列表。
 */
async function listAutoProfileDirs(baseUserDataDir: string): Promise<Array<{ profileId: string; dirName: string; fullPath: string }>> {
  const base = String(baseUserDataDir || '').trim();
  if (!base) return [];
  const parent = path.dirname(base);
  const baseName = path.basename(base);
  const profilePrefix = `${baseName}-profile-`;
  const autoPrefix = `${profilePrefix}auto-`;
  const out: Array<{ profileId: string; dirName: string; fullPath: string }> = [];
  const entries = await safeReaddir(parent);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = String(entry.name || '');
    if (!dirName.startsWith(autoPrefix)) continue;
    const profileId = dirName.slice(profilePrefix.length);
    if (!profileId) continue;
    out.push({ profileId, dirName, fullPath: path.join(parent, dirName) });
  }
  out.sort((a, b) => a.profileId.localeCompare(b.profileId));
  return out;
}

/**
 * 尝试彻底删除一个目录（先 rename 再 rm，避免“半删半留”）。
 * - busy 时回退原路径并返回 busy=true
 */
async function purgeDirectorySafely(dirPath: string): Promise<{ ok: boolean; busy?: boolean; notFound?: boolean; error?: string }> {
  const root = String(dirPath || '').trim();
  if (!root) return { ok: false, error: 'invalid path' };
  const exists = (() => {
    try { return fs.existsSync(root); } catch { return false; }
  })();
  if (!exists) return { ok: false, notFound: true, error: 'not found' };
  const parent = path.dirname(root);
  const temp = path.join(parent, makeTempName(path.basename(root)));
  try {
    await fsp.rename(root, temp);
  } catch (e) {
    const kind = classifyFsError(e);
    if (kind === 'missing') return { ok: false, notFound: true, error: formatFsError(e) };
    if (kind === 'busy') return { ok: false, busy: true, error: formatFsError(e) };
    return { ok: false, error: formatFsError(e) };
  }
  try {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
    return { ok: true };
  } catch (e) {
    const kind = classifyFsError(e);
    if (kind === 'busy') {
      try { await fsp.rename(temp, root).catch(() => undefined); } catch {}
      return { ok: false, busy: true, error: formatFsError(e) };
    }
    try { await fsp.rename(temp, root).catch(() => undefined); } catch {}
    try { await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined); } catch {}
    return { ok: false, error: formatFsError(e) };
  }
}

type DirectPurgeResult = {
  ok: boolean;
  after: AppDataInfo;
  removedEntries: number;
  skippedEntries: number;
  errors: Array<{ name: string; message: string }>;
};

async function directPurgeAppData(root: string, rounds = 3): Promise<DirectPurgeResult> {
  const aggregatedErrors: Array<{ name: string; message: string }> = [];
  let removedEntries = 0;
  let skippedEntries = 0;

  for (let attempt = 0; attempt < Math.max(1, rounds); attempt++) {
    const { errors, removedEntries: removed, skippedEntries: skipped } = await clearChildren(root, new Set(), {
      skipKnownLocks: false,
    });
    if (errors.length > 0) aggregatedErrors.push(...errors);
    removedEntries += removed;
    skippedEntries += skipped;

    let after = await summarize(root);
    if (after.dirCount === 0 && after.fileCount === 0) {
      try {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 90 });
      } catch {}
      await sleep(90);
      after = await summarize(root);
      const exists = (() => {
        try { return fs.existsSync(root); } catch { return false; }
      })();
      if (after.dirCount === 0 && after.fileCount === 0 && !exists) {
        return { ok: true, after, removedEntries, skippedEntries, errors: aggregatedErrors };
      }
    }
    await sleep(90 * (attempt + 1));
  }

  const after = await summarize(root);
  const exists = (() => {
    try { return fs.existsSync(root); } catch { return false; }
  })();
  const ok = after.dirCount === 0 && after.fileCount === 0 && !exists;
  return { ok, after, removedEntries, skippedEntries, errors: aggregatedErrors };
}

async function detachForExternalWiper(target: string): Promise<string> {
  try {
    if (!fs.existsSync(target)) return target;
  } catch {
    return target;
  }
  const parent = path.dirname(target);
  const next = path.join(parent, makeTempName(path.basename(target) || 'codexflow'));
  try {
    await fsp.rename(target, next);
    return next;
  } catch (err) {
    const kind = classifyFsError(err);
    if (kind === 'missing') return target;
    if (kind === 'busy') {
      await sleep(120);
    }
    return target;
  }
}

async function spawnExternalWiper(target: string): Promise<'scheduled' | 'immediate' | 'failed'> {
  if (!target) return 'failed';
  if (process.platform !== 'win32') {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return 'immediate';
    } catch {
      return 'failed';
    }
  }
  try {
    const batPath = path.join(os.tmpdir(), `codexflow-wipe-${Date.now().toString(36)}.bat`);
    const lines = [
      "@echo off",
      "setlocal enableextensions",
      "set \"TARGET=%~1\"",
      "",
      ":retry",
      "if not exist \"%TARGET%\" goto :done",
      "rmdir /s /q \"%TARGET%\" 2>nul",
      "if exist \"%TARGET%\" (",
      "  powershell -NoProfile -ExecutionPolicy Bypass -Command \"Remove-Item -LiteralPath ''%TARGET%'' -Recurse -Force -ErrorAction SilentlyContinue\" >nul 2>&1",
      ")",
      "if exist \"%TARGET%\" (",
      "  timeout /t 1 /nobreak >nul",
      "  goto :retry",
      ")",
      ":done",
      "del \"%~f0\" >nul 2>&1",
      "endlocal",
      "",
    ];
    const script = lines.join('\r\n');
    await fsp.writeFile(batPath, script, { encoding: 'utf8' });
    const child = spawn('cmd.exe', ['/c', batPath, target], {
      cwd: os.tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return 'scheduled';
  } catch {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return 'immediate';
    } catch {
      return 'failed';
    }
  }
}

function destroyAllWindows() {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      try { win.removeAllListeners(); } catch {}
      try { win.destroy(); } catch {}
    }
  } catch {}
}

async function summarize(root: string): Promise<AppDataInfo> {
  const base: AppDataInfo = {
    ok: true,
    path: root,
    totalBytes: 0,
    dirCount: 0,
    fileCount: 0,
    collectedAt: Date.now(),
  };
  const rootExists = fs.existsSync(root);
  if (!rootExists) {
    return base;
  }
  const queue: string[] = [root];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    if (visited.has(current)) continue;
    visited.add(current);
    const entries = await safeReaddir(current);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const stat = await safeStat(fullPath);
        if (stat) {
          base.totalBytes += stat.size;
          base.fileCount += 1;
        }
        continue;
      }
      if (entry.isDirectory()) {
        base.dirCount += 1;
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const stat = await safeStat(fullPath);
        if (stat) {
          base.fileCount += 1;
          base.totalBytes += stat.size;
        }
        continue;
      }
      // 其它类型（FIFO/Socket 等）当作文件处理，尽量统计体积
      const stat = await safeStat(fullPath);
      if (stat) {
        base.fileCount += 1;
        base.totalBytes += stat.size;
      }
    }
  }
  base.collectedAt = Date.now();
  return base;
}

async function clearChildren(root: string, preserveNames: Set<string>, opts: { skipKnownLocks?: boolean } = {}) {
  const entries = await safeReaddir(root);
  const errors: Array<{ name: string; message: string }> = [];
  let removedEntries = 0;
  let skippedEntries = 0;
  const skipKnownLocks = opts.skipKnownLocks !== false;
  for (const entry of entries) {
    if (preserveNames.has(entry.name)) {
      skippedEntries += 1;
      continue;
    }
    if (skipKnownLocks && KNOWN_LOCK_NAMES.has(entry.name)) {
      skippedEntries += 1;
      continue;
    }
    const target = path.join(root, entry.name);
    const isDir = entry.isDirectory();
    const isFile = entry.isFile() || entry.isSymbolicLink();
    if (isDir) {
      const tempName = makeTempName(entry.name);
      const tempPath = path.join(root, tempName);
      try {
        await fsp.rename(target, tempPath);
      } catch (renameErr) {
        const kind = classifyFsError(renameErr);
        if (kind === 'missing') {
          removedEntries += 1;
          continue;
        }
        if (kind === 'busy') {
          skippedEntries += 1;
          continue;
        }
        errors.push({ name: entry.name, message: formatFsError(renameErr) });
        continue;
      }
      try {
        await fsp.rm(tempPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
        removedEntries += 1;
        continue;
      } catch (rmErr) {
        const kind = classifyFsError(rmErr);
        if (kind === 'missing') {
          removedEntries += 1;
        } else if (kind === 'busy') {
          skippedEntries += 1;
          try { await fsp.rename(tempPath, target).catch(() => undefined); } catch {}
        } else {
          errors.push({ name: entry.name, message: formatFsError(rmErr) });
        }
        try { await fsp.rm(tempPath, { recursive: true, force: true }).catch(() => undefined); } catch {}
        continue;
      }
    }
    if (isFile) {
      try {
        await fsp.unlink(target);
        removedEntries += 1;
        continue;
      } catch (unlinkErr) {
        const kind = classifyFsError(unlinkErr);
        if (kind === 'missing') {
          removedEntries += 1;
        } else if (kind === 'busy') {
          skippedEntries += 1;
        } else {
          errors.push({ name: entry.name, message: formatFsError(unlinkErr) });
        }
        continue;
      }
    }
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
      removedEntries += 1;
    } catch (fallbackErr) {
      const kind = classifyFsError(fallbackErr);
      if (kind === 'missing') {
        removedEntries += 1;
      } else if (kind === 'busy') {
        skippedEntries += 1;
      } else {
        errors.push({ name: entry.name, message: formatFsError(fallbackErr) });
      }
    }
  }
  return { errors, removedEntries, skippedEntries };
}

async function getAppDataInfo(): Promise<AppDataInfo> {
  try {
    const root = getUserDataPath();
    await ensureDir(root);
    return await summarize(root);
  } catch (err) {
    return {
      ok: false,
      path: getUserDataPath(),
      totalBytes: 0,
      dirCount: 0,
      fileCount: 0,
      collectedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 获取所有 auto-* Profile 目录占用信息（只读统计）。
 */
async function getAutoProfilesInfo(): Promise<AutoProfilesInfo> {
  try {
    const baseUserData = getBaseUserDataPath();
    const currentUserData = getUserDataPath();
    const currentKey = normalizePathKey(currentUserData);
    const dirs = await listAutoProfileDirs(baseUserData);
    const items: AutoProfileDirInfo[] = [];
    let totalBytes = 0;
    for (const d of dirs) {
      const info = await summarize(d.fullPath);
      const isCurrent = normalizePathKey(d.fullPath) === currentKey;
      items.push({
        profileId: d.profileId,
        dirName: d.dirName,
        path: d.fullPath,
        totalBytes: info.totalBytes,
        dirCount: info.dirCount,
        fileCount: info.fileCount,
        collectedAt: info.collectedAt,
        isCurrent,
      });
      totalBytes += info.totalBytes;
    }
    return { ok: true, baseUserData, currentUserData, count: items.length, totalBytes, items };
  } catch (e) {
    return {
      ok: false,
      baseUserData: getBaseUserDataPath(),
      currentUserData: getUserDataPath(),
      count: 0,
      totalBytes: 0,
      items: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 一键回收（删除）所有 auto-* Profile 目录（默认跳过当前实例目录与占用目录）。
 */
async function purgeAutoProfiles(options: PurgeAutoProfilesOptions = {}): Promise<PurgeAutoProfilesResult> {
  const baseUserData = getBaseUserDataPath();
  const currentUserData = getUserDataPath();
  const currentKey = normalizePathKey(currentUserData);
  void options;
  const dirs = await listAutoProfileDirs(baseUserData);
  const errors: Array<{ profileId: string; path: string; message: string }> = [];
  let removed = 0;
  let skipped = 0;
  let busy = 0;
  let notFound = 0;
  let bytesFreed = 0;

  for (const d of dirs) {
    const isCurrent = normalizePathKey(d.fullPath) === currentKey;
    // 安全保护：绝不删除当前实例正在使用的 userData 目录
    if (isCurrent) {
      skipped += 1;
      continue;
    }
    const before = await summarize(d.fullPath).catch(() => null);
    const bytesBefore = before ? before.totalBytes : 0;
    const res = await purgeDirectorySafely(d.fullPath);
    if (res.notFound) {
      notFound += 1;
      continue;
    }
    if (res.busy) {
      busy += 1;
      skipped += 1;
      continue;
    }
    if (res.ok) {
      removed += 1;
      bytesFreed += Math.max(0, bytesBefore);
      continue;
    }
    skipped += 1;
    errors.push({ profileId: d.profileId, path: d.fullPath, message: res.error || 'failed' });
  }

  const total = dirs.length;
  const ok = errors.length === 0;
  const result: PurgeAutoProfilesResult = { ok, total, removed, skipped, busy, notFound, bytesFreed };
  if (!ok) {
    result.errors = errors;
    result.error = errors.map((x) => `${x.profileId}: ${x.message}`).join('; ');
  }
  return result;
}

async function clearAppData(options: ClearOptions = {}): Promise<ClearResult> {
  const root = getUserDataPath();
  await ensureDir(root);
  const before = await summarize(root);
  const preserveNames = new Set<string>();
  if (options.preserveSettings !== false) {
    preserveNames.add(SETTINGS_FILE);
  }
  await flushElectronSessions();
  const { errors, removedEntries, skippedEntries } = await clearChildren(root, preserveNames, { skipKnownLocks: true });
  await ensureDir(root);
  const after = await summarize(root);
  const result: ClearResult = {
    ok: errors.length === 0,
    path: root,
    bytesBefore: before.totalBytes,
    bytesAfter: after.totalBytes,
    bytesFreed: Math.max(0, before.totalBytes - after.totalBytes),
    removedEntries,
    skippedEntries,
  };
  if (errors.length > 0) {
    result.errors = errors;
    result.error = errors.map((item) => `${item.name}: ${item.message}`).join('; ');
  }
  return result;
}

async function purgeAppDataAndQuit(): Promise<ClearResult> {
  const root = getUserDataPath();
  await ensureDir(root);
  const before = await summarize(root);
  await flushElectronSessions();
  await prePurgeSessions();
  try { app.releaseSingleInstanceLock?.(); } catch {}
  const scheduleQuit = (delay = 160) => {
    setTimeout(() => {
      try { destroyAllWindows(); } catch {}
      try { app.quit(); } catch {}
    }, delay);
  };
  const direct = await directPurgeAppData(root, 4);
  let finalAfter = direct.after;
  if (direct.ok) {
    await sleep(120);
    finalAfter = await summarize(root);
    const exists = (() => {
      try { return fs.existsSync(root); } catch { return false; }
    })();
    if (finalAfter.dirCount === 0 && finalAfter.fileCount === 0 && !exists) {
      const bytesAfter = finalAfter.totalBytes;
      const bytesFreed = Math.max(0, before.totalBytes - bytesAfter);
      const result: ClearResult = {
        ok: true,
        path: root,
        bytesBefore: before.totalBytes,
        bytesAfter,
        bytesFreed,
        removedEntries: Math.max(direct.removedEntries, before.dirCount + before.fileCount),
        skippedEntries: direct.skippedEntries,
        note: direct.errors.length > 0 || direct.skippedEntries > 0
          ? '缓存已清理，应用即将退出；如检测到残留，后台脚本仍会继续尝试。'
          : '缓存已清理，应用即将退出。',
      };
      if (direct.errors.length > 0) {
        result.errors = direct.errors;
      }
      if (direct.errors.length > 0 || direct.skippedEntries > 0) {
        const target = await detachForExternalWiper(root);
        await spawnExternalWiper(target).catch(() => 'failed');
      }
      scheduleQuit(160);
      return result;
    }
  }
  const target = await detachForExternalWiper(root);
  const mode = await spawnExternalWiper(target);
  if (mode !== 'failed') {
    scheduleQuit(mode === 'immediate' ? 120 : 200);
  }
  const totalEntries = before.dirCount + before.fileCount;
  const bytesAfter = mode === 'immediate' ? 0 : finalAfter.totalBytes;
  const bytesFreed = Math.max(0, before.totalBytes - bytesAfter);
  const note = mode === 'scheduled'
    ? '缓存清理已交由系统后台处理，应用退出后将自动完成。'
    : (mode === 'immediate'
        ? '缓存已清理，应用即将退出。'
        : '缓存清理脚本启动失败，请手动删除用户数据目录。');
  const result: ClearResult = {
    ok: mode !== 'failed',
    path: root,
    bytesBefore: before.totalBytes,
    bytesAfter,
    bytesFreed,
    removedEntries: Math.max(direct.removedEntries, totalEntries),
    skippedEntries: direct.skippedEntries,
    scheduled: mode === 'scheduled',
    note,
  };
  if (mode === 'failed') {
    if (direct.errors.length > 0) {
      result.errors = direct.errors;
      result.error = direct.errors.map((item) => `${item.name}: ${item.message}`).join('; ');
    } else {
      result.error = note;
    }
  }
  return result;
}

export default {
  getAppDataInfo,
  clearAppData,
  purgeAppDataAndQuit,
  getAutoProfilesInfo,
  purgeAutoProfiles,
};
