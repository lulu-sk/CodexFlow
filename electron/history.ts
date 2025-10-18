// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { app } from 'electron';
import crypto from 'node:crypto';
import wsl, { isUNCPath, uncToWsl, getSessionsRootsFastAsync } from './wsl';
import { perfLogger } from './log';
import settings from './settings';

/**
 * History 读取模块: 支持逐行解析 JSONL, list/read 接口
 */

export type RuntimeShell = 'wsl' | 'windows' | 'unknown';

export type HistorySummary = {
  id: string;
  title: string;
  date: number;
  filePath: string;
  rawDate?: string;
  preview?: string;
  resumeMode?: 'modern' | 'legacy' | 'unknown';
  resumeId?: string;
  runtimeShell?: RuntimeShell;
};
// 消息内容：支持可选 tags（用于嵌套类型筛选，例如 message.input_text）
export type MessageContent = { type: string; text: string; tags?: string[] };
export type Message = { role: string; content: MessageContent[] };

export function detectRuntimeShell(filePath?: string): RuntimeShell {
  try {
    if (!filePath) return 'unknown';
    let raw = String(filePath).trim();
    if (!raw) return 'unknown';
    // 处理 \\?\UNC\ 前缀，统一为常规 UNC 形式
    if (raw.startsWith('\\\\?\\UNC\\')) raw = '\\\\' + raw.slice(8);
    if (raw.startsWith('\\\\?\\')) raw = raw.slice(4);
    const lowered = raw.toLowerCase();
    if (lowered.startsWith('\\\\wsl.localhost\\') || lowered.startsWith('\\\\wsl$\\') || lowered.startsWith('//wsl.localhost/')) {
      return 'wsl';
    }
    const replaced = lowered.replace(/\\/g, '/');
    if (replaced.startsWith('/mnt/')) return 'wsl';
    if (replaced.startsWith('/home/') || replaced.startsWith('/root/')) return 'wsl';
    if (/^[a-z]:\\/.test(raw)) return 'windows';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function classifyRuntimeShell(raw?: string): RuntimeShell {
  try {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 'unknown';
    const windowsHints = ['powershell', 'pwsh', 'cmd.exe', 'command prompt', 'cmd'];
    for (const hint of windowsHints) {
      if (s.includes(hint)) return 'windows';
    }
    const wslHints = ['bash', 'zsh', 'fish', 'wsl', 'ubuntu', 'debian', 'arch', 'alpine', '/bin/bash', '/bin/zsh'];
    for (const hint of wslHints) {
      if (s.includes(hint)) return 'wsl';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function extractShellFromEnvironmentContext(source?: string): string | null {
  try {
    if (!source) return null;
    let text = String(source);
    text = text.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
    const envRe = /<environment_context\b[^>]*>([\s\S]*?)<\/environment_context>/gi;
    let match: RegExpExecArray | null;
    while ((match = envRe.exec(text)) !== null) {
      const block = match[1] || '';
      const shellMatch = block.match(/<shell\b[^>]*>([\s\S]*?)<\/shell>/i);
      if (shellMatch && typeof shellMatch[1] === 'string') {
        const val = shellMatch[1].replace(/\\[rn]/g, '').trim();
        if (val) return val;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function detectRuntimeShellFromContent(parsed?: any, text?: string): RuntimeShell {
  try {
    const tryClassify = (value?: any): RuntimeShell => {
      if (typeof value !== 'string') return 'unknown';
      return classifyRuntimeShell(value);
    };
    if (parsed && typeof parsed === 'object') {
      const direct = tryClassify(parsed.shell ?? parsed.runtimeShell ?? parsed.terminal);
      if (direct !== 'unknown') return direct;
      if (parsed.payload && typeof parsed.payload === 'object') {
        const inPayload = tryClassify(parsed.payload.shell ?? parsed.payload.runtimeShell ?? parsed.payload.terminal);
        if (inPayload !== 'unknown') return inPayload;
      }
    }
    const rawShell = extractShellFromEnvironmentContext(text);
    if (rawShell) {
      const hint = classifyRuntimeShell(rawShell);
      if (hint !== 'unknown') return hint;
    }
    if (parsed && typeof parsed === 'object') {
      try {
        const serialized = JSON.stringify(parsed);
        const shellFromSerialized = extractShellFromEnvironmentContext(serialized);
        if (shellFromSerialized) {
          const hint = classifyRuntimeShell(shellFromSerialized);
          if (hint !== 'unknown') return hint;
        }
      } catch {}
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---- Debug helpers (also exposed via history.debugInfo) ----
function __userDataPath(): string { try { return app.getPath('userData'); } catch { return process.cwd(); } }
function __flagPath(): string { return path.join(__userDataPath(), 'history-debug.on'); }
function __flagExists(): boolean { try { fs.accessSync(__flagPath()); return true; } catch { return false; } }
function __envFlag(): string { return String(process.env.CODEX_HISTORY_DEBUG || ''); }
export function debugInfo() {
  return {
    userDataPath: __userDataPath(),
    flagPath: __flagPath(),
    flagExists: __flagExists(),
    env: __envFlag(),
    envEnabled: __envFlag().trim() === '1',
  };
}

function defaultHistoryRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function titleFromFilename(filePath: string): string {
  try {
    const base = path.basename(filePath).replace(/\.jsonl$/i, '');
    // 文件名示例：
    //  - rollout-2025-08-27T10-51-11-<uuid>.jsonl （旧格式）
    //  - rollout-2025-09-12T01-47-57-68647426-<uuid>.jsonl （新格式，秒后多一段随机数/序列）
    const m = base.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (m) {
      const [_, d, hh, mm, ss] = m;
      return `${d} ${hh}:${mm}:${ss}`;
    }
    // ISO-like with colons
    const m2 = base.match(/(\d{4}-\d{2}-\d{2})[T_ ](\d{2})[:\-](\d{2})[:\-](\d{2})/);
    if (m2) {
      const [_, d, hh, mm, ss] = m2;
      return `${d} ${hh}:${mm}:${ss}`;
    }
    return base;
  } catch {
    try { return path.basename(filePath); } catch { return 'Session'; }
  }
}

function clampTitle(s: string, max = 96): string {
  const ss = String(s || '').replace(/[\r\n]+/g, ' ').replace(/```[\s\S]*?```/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!ss) return '';
  return ss.length > max ? ss.slice(0, max - 1) + '…' : ss;
}

export function detectResumeInfo(parsed: any): { mode: 'modern' | 'legacy' | 'unknown'; id?: string } {
  try {
    if (!parsed || typeof parsed !== 'object') return { mode: 'unknown' };
    const type = String((parsed as any).type || '').toLowerCase();
    if (type === 'session_meta' && parsed.payload) {
      const payload = parsed.payload;
      const rid = payload && typeof payload.id !== 'undefined' ? String(payload.id) : undefined;
      return { mode: 'modern', id: rid };
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'id')) {
      const rid = parsed.id ? String(parsed.id) : undefined;
      return { mode: 'legacy', id: rid };
    }
  } catch {}
  return { mode: 'unknown' };
}

function looksNumericOnly(s: string): boolean {
  const t = String(s || '').trim();
  if (!t) return true;
  // treat dates / pure numbers / signed/decimal as numeric-like, not good titles
  if (/^[+\-]?[0-9]+(?:\.[0-9]+)?$/.test(t)) return true;
  if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(t)) return true;
  return false;
}

function extractTitleFromPrefix(prefix: string): { user?: string; assistant?: string } {
  const out: { user?: string; assistant?: string } = {};
  try {
    const lines = String(prefix || '').split(/\r?\n/).filter(Boolean).slice(0, 200);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const role = String(obj.role || obj.actor || obj.from || '').toLowerCase();
        const type = String(obj.type || obj.record_type || '').toLowerCase();
        if (type !== 'message') continue;
        let text = '';
        if (Array.isArray(obj.content)) {
          for (const c of obj.content) {
            if (!c) continue;
            const s = c.text ?? c.code ?? '';
            if (typeof s === 'string' && s.trim()) { text = s; break; }
          }
        } else if (typeof obj.content === 'string') {
          text = obj.content;
        } else if (typeof obj.input_text === 'string') {
          text = obj.input_text;
        }
        const cand = clampTitle(text);
        if (!cand || looksNumericOnly(cand)) continue;
        if (role === 'user' && !out.user) out.user = cand;
        else if (!out.assistant) out.assistant = cand;
        if (out.user && out.assistant) break;
      } catch { continue; }
    }
  } catch {}
  return out;
}

function deriveTitle(parsed: any, prefix: string, filePath: string, fallbackId: string): string {
  // Prefer explicit fields
  const pTitle = (parsed && typeof parsed.title === 'string') ? parsed.title : undefined;
  const pInstr = (parsed && typeof parsed.instructions === 'string') ? parsed.instructions : undefined;
  const first = clampTitle(pInstr || pTitle || '');
  if (first && !looksNumericOnly(first)) return first;
  // Next: pick first user message text from prefix, then assistant
  const msgs = extractTitleFromPrefix(prefix);
  if (msgs.user) return msgs.user;
  if (msgs.assistant) return msgs.assistant;
  // Fallback: directory or filename
  try {
    const base = path.basename(filePath).replace(/\.jsonl$/i, '') || fallbackId;
    return `Session ${base}`;
  } catch {
    return `Session ${fallbackId}`;
  }
}

// No timestamp parsing here; UI shows raw timestamp string, and ordering uses file mtime.

// ---- Persistent cache for history list results (fast-path when roots unchanged) ----
type RootSig = { root: string; latestDir?: string; latestFile?: string; mtimeMs?: number; size?: number };
type HistoryListCacheEntry = {
  key: string; // rootsKey || needlesKey
  roots: string[];
  needlesCanon: string[];
  sigs: RootSig[];
  list: HistorySummary[];
  savedAt: number;
};

function getHistoryCachePath(): string {
  const dir = app.getPath('userData');
  return path.join(dir, 'history.index.cache.json');
}

function loadHistoryCache(): HistoryListCacheEntry[] {
  try {
    const p = getHistoryCachePath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8')) as HistoryListCacheEntry[];
  } catch { return []; }
}

function saveHistoryCache(list: HistoryListCacheEntry[]) {
  try {
    // simple bound: keep most recent 30 entries
    const capped = list.sort((a, b) => b.savedAt - a.savedAt).slice(0, 30);
    fs.writeFileSync(getHistoryCachePath(), JSON.stringify(capped, null, 2), 'utf8');
  } catch {}
}

async function computeRootSig(root: string): Promise<RootSig> {
  const sig: RootSig = { root };
  try {
    const years = await fsp.readdir(root, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
    if (years.length === 0) return sig;
    const ySorted = years.slice().sort((a, b) => Number(b) - Number(a));
    for (const y of ySorted) {
      const ydir = path.join(root, y);
      const months = await fsp.readdir(ydir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
      if (months.length === 0) continue;
      const mSorted = months.slice().sort((a, b) => Number(b) - Number(a));
      for (const m of mSorted) {
        const mdir = path.join(ydir, m);
        const days = await fsp.readdir(mdir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
        if (days.length === 0) continue;
        const dSorted = days.slice().sort((a, b) => Number(b) - Number(a));
        for (const d of dSorted) {
          const ddir = path.join(mdir, d);
          const files = await fsp.readdir(ddir).then((fsx) => fsx.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
          if (files.length === 0) continue;
          // choose file with max mtime
          let best: { fp: string; mtimeMs: number; size: number } | null = null;
          for (const f of files) {
            const fp = path.join(ddir, f);
            try {
              const st = await fsp.stat(fp);
              if (!best || st.mtimeMs > best.mtimeMs) best = { fp, mtimeMs: st.mtimeMs, size: st.size };
            } catch {}
          }
          if (best) {
            sig.latestDir = ddir; sig.latestFile = best.fp; sig.mtimeMs = best.mtimeMs; sig.size = best.size;
            return sig;
          }
        }
      }
    }
  } catch {}
  return sig;
}

function sigsEqual(a: RootSig[], b: RootSig[]): boolean {
  if (a.length !== b.length) return false;
  const sortBy = (x: RootSig[]) => x.slice().sort((m, n) => String(m.root).localeCompare(String(n.root)));
  const aa = sortBy(a), bb = sortBy(b);
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i], y = bb[i];
    if (x.root !== y.root) return false;
    if (String(x.latestFile || '') !== String(y.latestFile || '')) return false;
    if (Number(x.mtimeMs || 0) !== Number(y.mtimeMs || 0)) return false;
  }
  return true;
}

export async function computeHistoryRoots(_historyRoot?: string): Promise<string[]> {
  // 新策略：不扫描、直接聚合 Windows 与所有 WSL 发行版的 ~/.codex/sessions（UNC/Windows 可直读）
  const roots = await perfLogger.time("computeHistoryRoots.getSessionsRootsFastAsync", async () => {
    return await getSessionsRootsFastAsync();
  });
  const exists: string[] = [];
  for (const r of roots) { try { await fsp.access(r); exists.push(r); } catch {} }
  return Array.from(new Set(exists));
}

export async function listHistory(project: { wslPath?: string; winPath?: string }, opts?: { historyRoot?: string; limit?: number; offset?: number }): Promise<HistorySummary[]> {
  const projectWslPath = project.wslPath || '';
  const projectWinPath = project.winPath || '';
  const rootOriginal = opts?.historyRoot || defaultHistoryRoot();
  const summaries: HistorySummary[] = [];
  const seenBelongs = new Set<string>();
  const seenAll = new Set<string>();
  // 文件摘要缓存（id/title/date/首段文本），用于快速判定与减少重复 IO
  type SumCache = {
    mtimeMs: number;
    size: number;
    id: string;
    title: string;
    date: number;
    prefix: string;
    rawDate?: string;
    resumeMode?: 'modern' | 'legacy' | 'unknown';
    resumeId?: string;
    runtimeShell?: RuntimeShell;
  };
  const g: any = global as any;
  if (!g.__historySummaryCache) g.__historySummaryCache = new Map<string, SumCache>();
  const summaryCache: Map<string, SumCache> = g.__historySummaryCache;
  // 与 computeHistoryRoots 保持一致：统一根目录解析逻辑，避免“设置里显示两个目录，但实际只扫一个”的不一致
  const rootsToScan: string[] = await computeHistoryRoots(rootOriginal);
  if (rootsToScan.length === 0) return summaries;
  // Fast-path: if roots' latest-file signature unchanged, reuse cached list
  const PARSER_VERSION = 'v7';
  const cacheKey = (rts: string[], nc: string[]) => `${rts.map((r) => r.toLowerCase()).sort().join('|')}||${nc.sort().join('|')}||${PARSER_VERSION}`;
  const needles = buildNeedles();
  // 将 needles 规范化为统一可对比的 WSL 风格（/mnt/c 或 /home/...），用于前缀对比
  function canon(p?: string): string {
    if (!p) return '';
    try {
      // Normalize common JSON-escaped artifacts first:
      // 1) collapse literal "\\n" sequences
      // 2) collapse doubled backslashes from JSON strings (e.g., C:\\code -> C:\code)
      // 3) trim stray quotes
      let s = String(p).replace(/\\n/g, '').replace(/\\\\+/g, '\\').replace(/^"|"$/g, '');
      if (isUNCPath(s)) {
        const info = uncToWsl(s);
        if (info) {
          let x = info.wslPath.split('\\').join('/');
          while (x.includes('//')) x = x.replace('//', '/');
          return x.toLowerCase();
        }
      }
      if (/^[a-zA-Z]:\\/.test(s)) {
        const w = wsl.winToWsl(s);
        if (w) {
          let x = w.split('\\').join('/');
          while (x.includes('//')) x = x.replace('//', '/');
          return x.toLowerCase();
        }
      }
      {
        let x = s.split('\\').join('/');
        while (x.includes('//')) x = x.replace('//', '/');
        return x.toLowerCase();
      }
    } catch {}
    {
      let x = String(p).split('\\').join('/');
      while (x.includes('//')) x = x.replace('//', '/');
      return x.toLowerCase();
    }
  }
  const needlesCanon = Array.from(new Set(needles.map(canon).filter(Boolean)));
  // Debug aid: write one log file when enabled by flag file
  function debugEnabled(): boolean {
    if (__envFlag().trim() === '1') return true;
    return __flagExists();
  }
  let __dbgCount = 0;
  function logDebug(msg: string) {
    if (!debugEnabled()) return;
    if (__dbgCount > 400) return; // avoid log explosion per call
    __dbgCount++;
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'history-debug.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8'); } catch {}
    // fallback: also try project cwd
    try { fs.appendFileSync(path.join(process.cwd(), 'history-debug.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8'); } catch {}
  }
  logDebug(`listHistory start projWin=${projectWinPath} projWsl=${projectWslPath} roots=${JSON.stringify(rootsToScan)}`);
  logDebug(`needles=${JSON.stringify(needles)} needlesCanon=${JSON.stringify(needlesCanon)}`);
  logDebug(`listHistory start projWin=${projectWinPath} projWsl=${projectWslPath} roots=${JSON.stringify(rootsToScan)}`);
  logDebug(`needles=${JSON.stringify(needles)} needlesCanon=${JSON.stringify(needlesCanon)}`);

  try {
    const sigsNow = await Promise.all(rootsToScan.map((r) => computeRootSig(r)));
    const all = loadHistoryCache();
    const key = cacheKey(rootsToScan, needlesCanon);
    const hit = all.find((e) => e.key === key);
    if (hit && sigsEqual(hit.sigs || [], sigsNow)) {
      logDebug(`cache-hit entries=${hit.list.length}`);
      // Prune entries that no longer exist to avoid stale "ghost" sessions
      const pruned = hit.list.filter((e) => {
        try { return fs.existsSync(e.filePath); } catch { return false; }
      });
      if (pruned.length !== hit.list.length) {
        try {
          const updated: HistoryListCacheEntry = { ...hit, list: pruned, savedAt: Date.now() };
          const others = (all || []).filter((x) => x.key !== hit.key);
          others.unshift(updated);
          saveHistoryCache(others);
          logDebug(`cache-pruned removed=${hit.list.length - pruned.length}`);
        } catch {}
      }
      const sliced = (opts?.offset || opts?.limit)
        ? pruned.slice(opts.offset || 0, (opts.offset || 0) + (opts.limit || pruned.length))
        : pruned.slice();
      return sliced.map((entry) => {
        const shell = entry.runtimeShell && entry.runtimeShell !== 'unknown' ? entry.runtimeShell : detectRuntimeShell(entry.filePath);
        return { ...entry, runtimeShell: shell };
      });
    }
  } catch {}
  function buildNeedles(): string[] {
    const out: string[] = [];
    const norm = (s?: string): string => {
      try {
        if (!s) return '';
        let v = String(s);
        // remove literal "\\n" sequences and surrounding quotes
        v = v.replace(/\\n/g, '');
        v = v.replace(/^"|"$/g, '');
        // collapse doubled backslashes in JSON strings (G:\\code -> G:\code)
        v = v.replace(/\\\\/g, '\\');
        // trim whitespace
        v = v.trim();
        // drop trailing slashes/backslashes noise
        v = v.replace(/[\\/]+$/g, '');
        return v;
      } catch { return String(s || '').trim(); }
    };
    const push = (v?: string) => { const t = norm(v); if (t) out.push(t); };
    const pw = (projectWslPath || '').split('\\').join('/').replace(/\/$/, '');
    const pm = (projectWinPath || '').replace(/[\\/]+$/, '');
    if (pw) push(pw);
    if (pm) {
      push(pm);
      push(pm.split('\\').join('/'));
      // JSON-escaped Windows variant (e.g., G:\\Projects\\CodexFlow) for raw JSONL substring match
      try {
        const pmEsc = String(pm).split('\\').join('\\\\'); // single backslash -> double
        if (pmEsc) out.push(pmEsc);
      } catch {}
    }
    // 从 WSL /mnt/驱动器 反推 Windows 盘符路径
    try {
      const m = pw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (m) {
        const drv = m[1].toUpperCase();
        const rest = m[2].split('/').join('\\\\');
        const drvWin = `${drv}:\\${rest}`;
        push(drvWin);
        // Also push escaped variant for JSONL content
        try { out.push(drvWin.split('\\').join('\\\\')); } catch {}
        push(`${drv}:/${m[2]}`);
      }
    } catch {}
    // 从 UNC 反推 WSL 路径
    try {
      if (isUNCPath(pm)) {
        const info = uncToWsl(pm);
        if (info) push(info.wslPath.split('\\').join('/'));
      }
    } catch {}
    // 从 Windows 盘符正向生成 WSL 路径
    try {
      if (/^[a-zA-Z]:\\/.test(pm)) {
        const w = wsl.winToWsl(pm);
        if (w) push(w.split('\\').join('/'));
      }
    } catch {}
    return Array.from(new Set(out.filter(Boolean)));
  }

  async function fileContainsAny(fp: string, needles: string[], maxBytes = 128 * 1024, cachedLower?: string): Promise<boolean> {
    if (needles.length === 0) return true;
    if (typeof cachedLower === 'string') {
      const low = cachedLower;
      for (const n of needles) {
        if (n && low.includes(String(n).toLowerCase())) return true;
      }
      return false;
    }
    try {
      const found = await new Promise<boolean>((resolve) => {
        const rs = fs.createReadStream(fp, { encoding: 'utf8', start: 0, end: Math.max(0, maxBytes - 1), highWaterMark: 32 * 1024 });
        let acc = '';
        let done = false;
        const finish = (v: boolean) => { if (!done) { done = true; try { rs.close(); } catch {} resolve(v); } };
        rs.on('data', (chunk) => {
          if (done) return;
          acc += chunk;
          const low = acc.toLowerCase();
          for (const n of needles) {
            if (n && low.includes(String(n).toLowerCase())) return finish(true);
          }
          if (acc.length >= maxBytes) finish(false);
        });
        rs.on('end', () => finish(false));
        rs.on('error', () => finish(false));
      });
      return found;
    } catch {
      return false;
    }
  }
  // 额外兜底：若前缀中未命中，则按流式方式在更大范围内搜索 <cwd> 或
  // "Current working directory:"，以应对前置有大量 reasoning/encrypted_content 的日志。
  async function extractCwdFromFile(fp: string, opts?: { maxScanBytes?: number }): Promise<string> {
    const maxScan = Math.max(64 * 1024, Math.min(16 * 1024 * 1024, opts?.maxScanBytes ?? 2 * 1024 * 1024));
    try {
      const rs = fs.createReadStream(fp, { encoding: 'utf8', highWaterMark: 64 * 1024 });
      let acc = '';
      let scanned = 0;
      const reCwdTag = /<cwd>\s*([^<]+?)\s*<\/cwd>/i;
      const reCwdLine = /Current\s+working\s+directory:\s*([^\r\n]+)/i;
      const tidy = (v?: string) => {
        try {
          if (typeof v !== 'string') return '';
          let s = v.replace(/\\n/g, '')
            .replace(/^"|"$/g, '')
            .replace(/\\\\/g, '\\')
            .trim()
            .replace(/[\\/]+$/g, '');
          return s;
        } catch { return String(v || '').trim(); }
      };
      return await new Promise<string>((resolve) => {
        const finish = (val: string) => { try { rs.close(); } catch {} resolve(val); };
        rs.on('data', (chunk) => {
          scanned += chunk.length;
          acc += chunk;
          // 限制 acc 的长度，避免内存暴涨（保留尾部 128KB 足够跨块匹配）
          if (acc.length > 256 * 1024) acc = acc.slice(acc.length - 128 * 1024);
          const m1 = acc.match(reCwdTag);
          if (m1 && m1[1]) return finish(tidy(m1[1]));
          const m2 = acc.match(reCwdLine);
          if (m2 && m2[1]) return finish(tidy(m2[1]));
          if (scanned >= maxScan) return finish('');
        });
        rs.on('end', () => finish(''));
        rs.on('error', () => finish(''));
      });
    } catch { return ''; }
  }

  // needlesCanon computed above
  const summariesAll: HistorySummary[] = [];
  // 生成规范化去重 key：优先转为 WSL 路径（UNC/Win 盘符转 /mnt/...），再小写处理
  function canonicalKey(p: string): string {
    try {
      if (isUNCPath(p)) {
        const info = uncToWsl(p);
        if (info) return info.wslPath.replace(/\\/g, '/');
      }
      if (/^[a-zA-Z]:\\/.test(p)) {
        const w = wsl.winToWsl(p);
        if (w) return w.replace(/\\/g, '/');
      }
    } catch {}
    return p.replace(/\\/g, '/');
  }

  for (const scanRoot of rootsToScan) {
    const years = await fsp.readdir(scanRoot, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
    for (const y of years) {
      const ydir = path.join(scanRoot, y);
      const months = await fsp.readdir(ydir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
      for (const m of months) {
      const mdir = path.join(ydir, m);
      const days = await fsp.readdir(mdir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
      for (const d of days) {
        const ddir = path.join(mdir, d);
        const files = await fsp.readdir(ddir).then((fs) => fs.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
        for (const f of files) {
          const fp = path.join(ddir, f);
          const key = canonicalKey(fp).toLowerCase();
          try {
            // 读取 stat 与缓存摘要
            const stat = await fsp.stat(fp).catch(() => null as any);
            let cached = (stat && summaryCache.get(fp) && summaryCache.get(fp)!.mtimeMs === stat.mtimeMs && summaryCache.get(fp)!.size === stat.size)
              ? summaryCache.get(fp)!
              : undefined;
            let prefix: string = '';
            let firstLine = '';
            let parsed: any = null;
            let id = f.replace(/\.jsonl$/, '');
            let timestamp = 0;
            let rawDate: string | undefined = undefined;
            let title = titleFromFilename(fp);
            let resumeMode: 'modern' | 'legacy' | 'unknown' = 'unknown';
            let resumeId: string | undefined = undefined;
            let runtimeShell: RuntimeShell = 'unknown';
            if (cached) {
              id = cached.id;
              timestamp = cached.date;
              prefix = cached.prefix || '';
              rawDate = cached.rawDate;
              resumeMode = cached.resumeMode ?? 'unknown';
              resumeId = cached.resumeId;
              if (cached.runtimeShell && cached.runtimeShell !== 'unknown') runtimeShell = cached.runtimeShell;
              firstLine = (prefix.split(/\r?\n/).find(Boolean) || '').trim();
              try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
              let changed = false;
              if (parsed && (!rawDate || typeof rawDate !== 'string')) {
                try {
                  if (Object.prototype.hasOwnProperty.call(parsed, 'timestamp')) {
                    rawDate = String(parsed.timestamp);
                    changed = true;
                  } else if (parsed.type === 'session_meta' && parsed.payload && Object.prototype.hasOwnProperty.call(parsed.payload, 'timestamp')) {
                    rawDate = String(parsed.payload.timestamp);
                    changed = true;
                  }
                } catch {}
              }
              if (parsed && resumeMode === 'unknown') {
                const info = detectResumeInfo(parsed);
                if (info.mode !== 'unknown') {
                  resumeMode = info.mode;
                  if (info.id) resumeId = info.id;
                  changed = true;
                }
              }
              const hint = detectRuntimeShellFromContent(parsed, prefix);
              if (runtimeShell === 'unknown') {
                if (hint !== 'unknown') {
                  runtimeShell = hint;
                  changed = true;
                }
              } else if (hint !== 'unknown' && hint !== runtimeShell) {
                runtimeShell = hint;
                changed = true;
              }
              if (runtimeShell === 'unknown') {
                const fallback = detectRuntimeShell(fp);
                const cachedShell = cached.runtimeShell ?? 'unknown';
                if (fallback !== 'unknown' && fallback !== cachedShell) {
                  runtimeShell = fallback;
                  changed = true;
                } else if (fallback !== 'unknown' && cachedShell === 'unknown') {
                  runtimeShell = fallback;
                  changed = true;
                }
              }
              if (stat && changed) {
                const entry: SumCache = { ...cached, rawDate, resumeMode, resumeId: resumeId || cached.resumeId || cached.id, runtimeShell };
                summaryCache.set(fp, entry);
              }
            } else {
              // 读取文件前缀，尽量只解析首段，减少 IO
              prefix = await new Promise((resolve) => {
                const rs = fs.createReadStream(fp, { encoding: 'utf8', start: 0, end: 128 * 1024 - 1 });
                let buf = '';
                rs.on('data', (c) => { buf += c; if (buf.length >= 128 * 1024) { try { rs.close(); } catch {} resolve(buf); } });
                rs.on('end', () => resolve(buf));
                rs.on('error', () => resolve(''));
              });
              firstLine = (prefix.split(/\r?\n/).find(Boolean) || '').trim();
              try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
              // 兼容新旧头格式：
              //  - 旧：首行为 { id, timestamp, instructions, git }
              //  - 新：首行为 { timestamp, type: 'session_meta', payload: { id, timestamp, cwd, instructions, git } }
              id = parsed?.id || (parsed?.payload?.id) || id;
              const info = detectResumeInfo(parsed);
              resumeMode = info.mode;
              if (info.id) resumeId = info.id;
              const hint = detectRuntimeShellFromContent(parsed, prefix);
              if (hint !== 'unknown') {
                runtimeShell = hint;
              }
              // 生成时间戳/标题
              try {
                if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'timestamp')) {
                  rawDate = String(parsed.timestamp);
                } else if (parsed && parsed.type === 'session_meta' && parsed.payload && Object.prototype.hasOwnProperty.call(parsed.payload, 'timestamp')) {
                  rawDate = String(parsed.payload.timestamp);
                }
              } catch { rawDate = undefined; }
              // Do not trust or parse timestamp for ordering; we'll use file mtime for numeric date
              // Do not use parsed timestamp for ordering; rely on file mtime
              timestamp = stat?.mtimeMs || 0;
              // Title: prefer filename timestamp (simple and stable)
              title = titleFromFilename(fp);
              if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
              // 写入缓存
              if (stat) {
                const entry: SumCache = { mtimeMs: stat.mtimeMs, size: stat.size, id, title, date: timestamp, prefix, rawDate, resumeMode, resumeId: resumeId || id, runtimeShell };
                // 简单限长
                if (summaryCache.size > 2000) {
                  let i = 0; for (const k of summaryCache.keys()) { summaryCache.delete(k); if (++i >= 200) break; }
                }
                summaryCache.set(fp, entry);
              }
            }
            if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
            // 严格按项目归属过滤：优先从元信息/前缀中提取 cwd，再与 needles 前缀匹配；否则回退到全文前缀搜索
            let belongs = true;
            if (needlesCanon.length > 0) {
              // 收集可能的工作目录线索
              const candidates: string[] = [];
              try {
                const tidy = (v?: string) => {
                  try {
                    if (typeof v !== 'string') return '';
                    let s = v.replace(/\\n/g, '')
                      .replace(/^"|"$/g, '')
                      .replace(/\\\\/g, '\\')
                      .trim()
                      .replace(/[\\/]+$/g, '');
                    return s;
                  } catch { return String(v || '').trim(); }
                };
                const tryPush = (v?: string) => { const t = tidy(v); if (t) candidates.push(t); };
                if (parsed) {
                  tryPush(parsed.cwd);
                  tryPush(parsed.working_dir);
                  tryPush(parsed.projectDir);
                  if (parsed.winPath) tryPush(parsed.winPath);
                  if (parsed.wslPath) tryPush(parsed.wslPath);
                  // 嵌套 session_meta.payload
                  try { if (parsed.type === 'session_meta' && parsed.payload) { tryPush(parsed.payload.cwd); } } catch {}
                }
                const m1 = (prefix || '').match(/Current\s+working\s+directory:\s*([^\r\n]+)/i);
                if (m1 && m1[1]) tryPush(m1[1]);
                const mCwdTag = (prefix || '').match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
                if (mCwdTag && mCwdTag[1]) tryPush(mCwdTag[1]);
              } catch {}
              let cCanon = Array.from(new Set(candidates.map(canon).filter(Boolean)));
              // 路径边界匹配：仅当候选 cwd 在项目路径之内（含相等）时命中
              const startsWithBoundary = (child: string, parent: string): boolean => {
                try {
                  if (!child || !parent) return false;
                  const c = child.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
                  const p = parent.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
                  if (c === p) return true;
                  return c.startsWith(p + '/');
                } catch { return false; }
              };
              if (cCanon.length > 0) {
                belongs = cCanon.some((c) => needlesCanon.some((n) => startsWithBoundary(c, n)));
                logDebug(`belongs[meta] file=${fp} cCanon=${JSON.stringify(cCanon)} match=${belongs}`);
              } else {
                // 先查找前缀（128KB）中是否包含项目路径子串
                let hit = await fileContainsAny(fp, needles, 128 * 1024, (prefix || '').toLowerCase());
                if (!hit) {
                  // 兜底：流式扫描更大范围，提取 <cwd> / CWD 行后再做前缀匹配
                  try {
                    const cwdFromFile = await extractCwdFromFile(fp, { maxScanBytes: 2 * 1024 * 1024 });
                    if (cwdFromFile) {
                      const cc = canon(cwdFromFile);
                      if (cc) hit = needlesCanon.some((n) => startsWithBoundary(cc, n));
                      logDebug(`fallback-cwd file=${fp} cwd=${cwdFromFile} cc=${cc} match=${hit}`);
                    } else {
                      logDebug(`fallback-cwd-empty file=${fp}`);
                    }
                  } catch {}
                }
                belongs = !!hit;
                logDebug(`belongs[prefix/fallback] file=${fp} match=${belongs}`);
              }
            }
            // 构造基础条目（用于回退展示）
            if (!resumeId) resumeId = id;
            const basic: HistorySummary = { id, title, date: (stat?.mtimeMs || 0), filePath: fp, rawDate, resumeMode, resumeId, runtimeShell };
            if (!seenAll.has(key)) { summariesAll.push(basic); seenAll.add(key); }
            if (belongs && !seenBelongs.has(key)) { summaries.push(basic); seenBelongs.add(key); }
          } catch (e) {
            continue;
          }
        }
      }
    }
    }
  }
  const finalList = summaries.sort((a, b) => b.date - a.date);
  const off = opts?.offset || 0;
  const end = opts?.limit ? off + (opts!.limit) : undefined;
  const sliced = finalList.slice(off, end);
  // Save cache for fast-path next time
  try {
    const sigsNow = await Promise.all(rootsToScan.map((r) => computeRootSig(r)));
    const all = loadHistoryCache();
    const key = `${rootsToScan.map((r) => r.toLowerCase()).sort().join('|')}||${needlesCanon.sort().join('|')}||${PARSER_VERSION}`;
    const next: HistoryListCacheEntry = { key, roots: rootsToScan, needlesCanon, sigs: sigsNow, list: finalList, savedAt: Date.now() };
    const filtered = all.filter((e) => e.key !== key);
    filtered.unshift(next);
    saveHistoryCache(filtered);
    logDebug(`cache-save entries=${finalList.length}`);
  } catch {}
  return sliced;
}

// List both belongs-to-project and all sessions for the same roots.
export async function listHistorySplit(project: { wslPath?: string; winPath?: string }, opts?: { historyRoot?: string; limit?: number; offset?: number }): Promise<{ belongs: HistorySummary[]; all: HistorySummary[] }> {
  const belongs = await listHistory(project, opts);
  const rootOriginal = opts?.historyRoot || defaultHistoryRoot();
  const rootsToScan: string[] = await computeHistoryRoots(rootOriginal);
  type SumCache = {
    mtimeMs: number;
    size: number;
    id: string;
    title: string;
    date: number;
    prefix: string;
    rawDate?: string;
    resumeMode?: 'modern' | 'legacy' | 'unknown';
    resumeId?: string;
    runtimeShell?: RuntimeShell;
  };
  const g: any = global as any;
  if (!g.__historySummaryCache) g.__historySummaryCache = new Map<string, SumCache>();
  const summaryCache: Map<string, SumCache> = g.__historySummaryCache;
  const all: HistorySummary[] = [];
  for (const scanRoot of rootsToScan) {
    const years = await fsp.readdir(scanRoot, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
    for (const y of years) {
      const ydir = path.join(scanRoot, y);
      const months = await fsp.readdir(ydir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
      for (const m of months) {
        const mdir = path.join(ydir, m);
        const days = await fsp.readdir(mdir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
        for (const d of days) {
          const ddir = path.join(mdir, d);
          const files = await fsp.readdir(ddir).then((fsx) => fsx.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
          for (const f of files) {
            const fp = path.join(ddir, f);
            try {
              const stat = await fsp.stat(fp).catch(() => null as any);
              let cached = (stat && summaryCache.get(fp) && summaryCache.get(fp)!.mtimeMs === stat.mtimeMs && summaryCache.get(fp)!.size === stat.size)
                ? summaryCache.get(fp)!
                : undefined;
              let prefix: string = '';
              let firstLine = '';
              let parsed: any = null;
              let id = f.replace(/\.jsonl$/, '');
              let timestamp = 0;
              let rawDate: string | undefined = undefined;
              let title = titleFromFilename(fp);
              let resumeMode: 'modern' | 'legacy' | 'unknown' = 'unknown';
              let resumeId: string | undefined = undefined;
              let runtimeShell: RuntimeShell = 'unknown';
              if (cached) {
                id = cached.id;
                timestamp = cached.date;
                prefix = cached.prefix || '';
                rawDate = cached.rawDate;
                resumeMode = cached.resumeMode ?? 'unknown';
                resumeId = cached.resumeId;
                if (cached.runtimeShell && cached.runtimeShell !== 'unknown') runtimeShell = cached.runtimeShell;
                firstLine = (prefix.split(/\r?\n/).find(Boolean) || '').trim();
                try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
                let changed = false;
                if (parsed && (!rawDate || typeof rawDate !== 'string')) {
                  try {
                    if (Object.prototype.hasOwnProperty.call(parsed, 'timestamp')) {
                      rawDate = String(parsed.timestamp);
                      changed = true;
                    } else if (parsed.type === 'session_meta' && parsed.payload && Object.prototype.hasOwnProperty.call(parsed.payload, 'timestamp')) {
                      rawDate = String(parsed.payload.timestamp);
                      changed = true;
                    }
                  } catch {}
                }
                if (parsed && resumeMode === 'unknown') {
                  const info = detectResumeInfo(parsed);
                  if (info.mode !== 'unknown') {
                    resumeMode = info.mode;
                    if (info.id) {
                      resumeId = info.id;
                    }
                    changed = true;
                  }
                }
                const hint = detectRuntimeShellFromContent(parsed, prefix);
                if (runtimeShell === 'unknown') {
                  if (hint !== 'unknown') {
                    runtimeShell = hint;
                    changed = true;
                  }
                } else if (hint !== 'unknown' && hint !== runtimeShell) {
                  runtimeShell = hint;
                  changed = true;
                }
                if (runtimeShell === 'unknown') {
                  const fallback = detectRuntimeShell(fp);
                  const cachedShell = cached.runtimeShell ?? 'unknown';
                  if (fallback !== 'unknown' && fallback !== cachedShell) {
                    runtimeShell = fallback;
                    changed = true;
                  } else if (fallback !== 'unknown' && cachedShell === 'unknown') {
                    runtimeShell = fallback;
                    changed = true;
                  }
                }
                if (stat && changed) {
                  const entry: SumCache = { ...cached, rawDate, resumeMode, resumeId: resumeId || cached.resumeId || cached.id, runtimeShell };
                  summaryCache.set(fp, entry);
                }
              } else {
                prefix = await new Promise((resolve) => {
                  const rs = fs.createReadStream(fp, { encoding: 'utf8', start: 0, end: 128 * 1024 - 1 });
                  let buf = '';
                  rs.on('data', (c) => { buf += c; if (buf.length >= 128 * 1024) { try { rs.close(); } catch {} resolve(buf); } });
                  rs.on('end', () => resolve(buf));
                  rs.on('error', () => resolve(''));
                });
                firstLine = (prefix.split(/\r?\n/).find(Boolean) || '').trim();
                try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
                id = parsed?.id || (parsed?.payload?.id) || id;
                const info = detectResumeInfo(parsed);
                resumeMode = info.mode;
                if (info.id) resumeId = info.id;
                const hint = detectRuntimeShellFromContent(parsed, prefix);
                if (hint !== 'unknown') runtimeShell = hint;
                if (parsed) {
                  try {
                    if (Object.prototype.hasOwnProperty.call(parsed, 'timestamp')) {
                      rawDate = String(parsed.timestamp);
                    } else if (parsed.type === 'session_meta' && parsed.payload && Object.prototype.hasOwnProperty.call(parsed.payload, 'timestamp')) {
                      rawDate = String(parsed.payload.timestamp);
                    }
                  } catch { rawDate = undefined; }
                }
                timestamp = stat?.mtimeMs || 0;
                title = titleFromFilename(fp);
                if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
                if (stat) {
                  const entry: SumCache = { mtimeMs: stat.mtimeMs, size: stat.size, id, title, date: timestamp, prefix, rawDate, resumeMode, resumeId: resumeId || id, runtimeShell };
                  if (summaryCache.size > 2000) { let i = 0; for (const k of summaryCache.keys()) { summaryCache.delete(k); if (++i >= 200) break; } }
                  summaryCache.set(fp, entry);
                }
              }
              if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
              if (!resumeId) resumeId = id;
              all.push({ id, title, date: (stat?.mtimeMs || 0), filePath: fp, rawDate, resumeMode, resumeId, runtimeShell });
            } catch {}
          }
        }
      }
    }
  }
  const sortDesc = (a: HistorySummary, b: HistorySummary) => b.date - a.date;
  return { belongs: belongs.slice().sort(sortDesc), all: all.sort(sortDesc) };
}

export async function readHistoryFile(filePath: string, opts?: { chunkSize?: number; maxLines?: number }): Promise<{ id: string; title: string; date: number; messages: Message[]; skippedLines: number }> {
  // 简单缓存：基于文件 mtimeMs + size，避免重复解析未变更文件
  type CacheVal = { mtimeMs: number; size: number; result: { id: string; title: string; date: number; messages: Message[]; skippedLines: number } };
  const g: any = global as any;
  if (!g.__historyCache) g.__historyCache = new Map<string, CacheVal>();
  const cache: Map<string, CacheVal> = g.__historyCache;

  const chunk = opts?.chunkSize || 1024 * 1024; // 1MB
  const maxLines = Math.max(1, Math.min(100000, opts?.maxLines ?? 5000));
  const messages: Message[] = [];
  let skipped = 0;
  let id = path.basename(filePath).replace(/\.jsonl$/, '');
  let title = id;
  let date = 0;
  // 说明类去重：会话头 instructions 与用户 <user_instructions> 可能内容相同
  const __seenInstructions = new Set<string>();
  const __normInstr = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // 读取 stat 并检查缓存
  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (stat) {
    const key = filePath;
    const prev = cache.get(key);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      return prev.result;
    }
  }

  // 统一的行解析函数，便于 UNC/WSL 与本地读取共享逻辑
  function pretty(v: any): string {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  function parseLine(line: string, lineIndex: number) {
    if (!line.trim()) return lineIndex;
    try {
      const obj = JSON.parse(line);
      if (lineIndex === 0) {
        // 新版：顶层为 session_meta，真实头部在 payload 中
        if (obj && obj.type === 'session_meta' && obj.payload) {
          try { if (obj.payload.id) id = String(obj.payload.id); } catch {}
          try {
            const minimal = { id: obj.payload.id, timestamp: obj.payload.timestamp || obj.timestamp, originator: obj.payload.originator, cli_version: obj.payload.cli_version };
            messages.push({ role: 'meta', content: [{ type: 'session_meta', text: pretty(minimal) }] });
          } catch {}
          try {
            if (typeof obj.payload.instructions === 'string' && obj.payload.instructions.trim()) {
              const t = String(obj.payload.instructions);
              const k = __normInstr(t);
              if (!__seenInstructions.has(k)) {
                __seenInstructions.add(k);
                messages.push({ role: 'system', content: [{ type: 'instructions', text: t, tags: ['session_meta.instructions','session_instructions','instructions'] }] });
              }
            }
          } catch {}
          try { if (obj.payload.git) messages.push({ role: 'state', content: [{ type: 'git', text: pretty(obj.payload.git), tags: ['session_meta.git'] }] }); } catch {}
        } else {
          // 旧版：首行即为会话头
          id = obj.id || id;
          title = obj.instructions || obj.title || title;
          if (Object.prototype.hasOwnProperty.call(obj, 'timestamp')) {
            // Ignore log timestamp for numeric ordering; UI will display raw value from list API
          }
          // 额外：首行如包含 instructions/git，作为独立消息纳入详情
          try {
            if (typeof obj.instructions === 'string' && obj.instructions.trim().length > 0) {
              const t = String(obj.instructions);
              const k = __normInstr(t);
              if (!__seenInstructions.has(k)) {
                __seenInstructions.add(k);
                messages.push({ role: 'system', content: [{ type: 'instructions', text: t, tags: ['session_instructions','instructions'] }] });
              }
            }
            if (obj.git) {
              messages.push({ role: 'state', content: [{ type: 'git', text: pretty(obj.git) }] });
            }
          } catch {}
        }
      }
      // 辅助：识别“仅包含会话头元信息”的记录（无显式 type），避免被归为 unknown
      // 兼容新旧头格式：不再强制要求 instructions 必存在
      const isSessionHeader = (
        (obj && typeof obj === 'object') &&
        !obj.type && !obj.record_type &&
        Object.prototype.hasOwnProperty.call(obj, 'id') &&
        Object.prototype.hasOwnProperty.call(obj, 'timestamp')
      );
      if (obj.type === 'message' || obj.record_type === 'message' || (obj.type === 'response_item' && obj.payload && (obj.payload.type === 'message' || obj.payload.record_type === 'message'))) {
        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
        const role = src.role || src.actor || src.from || 'user';
        const contentArr: MessageContent[] = [];
        // 仅“前缀”匹配提取 <user_instructions>/<environment_context>，不做全文搜索
        const extractTaggedPrefix = (s: string) => {
          const src = String(s || '');
          const picked: MessageContent[] = [];
          const leading = (src.match(/^\s*/) || [''])[0].length;
          const s2 = src.slice(leading);
          const openU = '<user_instructions>';
          const closeU = '</user_instructions>';
          const openE = '<environment_context>';
          const closeE = '</environment_context>';
          // 优先匹配 user_instructions 前缀
          if (s2.toLowerCase().startsWith(openU)) {
            const end = s2.toLowerCase().indexOf(closeU);
            if (end >= 0) {
              const inner = s2.slice(openU.length, end);
              picked.push({ type: 'instructions', text: inner });
              const rest = s2.slice(end + closeU.length);
              return { rest: rest.trim(), picked };
            }
            // 未找到结束标签：全部作为该分类
            const inner = s2.slice(openU.length);
            picked.push({ type: 'instructions', text: inner });
            return { rest: '', picked };
          }
          // 匹配 environment_context 前缀
          if (s2.toLowerCase().startsWith(openE)) {
            const end = s2.toLowerCase().indexOf(closeE);
            if (end >= 0) {
              const inner = s2.slice(openE.length, end);
              picked.push({ type: 'environment_context', text: inner });
              const rest = s2.slice(end + closeE.length);
              return { rest: rest.trim(), picked };
            }
            const inner = s2.slice(openE.length);
            picked.push({ type: 'environment_context', text: inner });
            return { rest: '', picked };
          }
          return { rest: src, picked };
        };
        if (Array.isArray(src.content)) {
          for (const c of src.content) {
            if (!c) continue;
            if (c.type && (c.text || c.code || c.payload)) {
              const text = c.text ?? c.code ?? pretty(c.payload ?? '');
              const s = String(text ?? '');
              if (s.trim().length === 0) continue;
              // 将 input_text/text 中的标签内容单独分离分类
              if (String(c.type).toLowerCase() === 'input_text' || String(c.type).toLowerCase() === 'text') {
                const { rest, picked } = extractTaggedPrefix(s);
                if (picked.length > 0) {
                  for (const it of picked) {
                    if (String(it.type).toLowerCase() === 'instructions') {
                      const k = __normInstr(String(it.text || ''));
                      if (k && __seenInstructions.has(k)) continue;
                      if (k) __seenInstructions.add(k);
                    }
                    const innerTag = 'message.' + String(it.type).toLowerCase();
                    const containerTag = 'message.' + String(c.type).toLowerCase();
                    contentArr.push({ ...it, tags: Array.from(new Set([...(it.tags || []), innerTag, containerTag])) });
                  }
                  if (rest.trim().length > 0) contentArr.push({ type: String(c.type), text: rest, tags: ['message.' + String(c.type).toLowerCase()] });
                } else {
                  contentArr.push({ type: String(c.type), text: s, tags: ['message.' + String(c.type).toLowerCase()] });
                }
              } else {
                contentArr.push({ type: String(c.type), text: s, tags: ['message.' + String(c.type).toLowerCase()] });
              }
            } else if (typeof c === 'string') {
              const s = String(c);
              if (s.trim().length === 0) continue;
              const { rest, picked } = extractTaggedPrefix(s);
              if (picked.length > 0) {
                for (const it of picked) {
                  if (String(it.type).toLowerCase() === 'instructions') {
                    const k = __normInstr(String(it.text || ''));
                    if (k && __seenInstructions.has(k)) continue;
                    if (k) __seenInstructions.add(k);
                  }
                  contentArr.push({ ...it, tags: Array.from(new Set([...(it.tags || []), 'message.' + String(it.type).toLowerCase()])) });
                }
                if (rest.trim().length > 0) contentArr.push({ type: 'text', text: rest, tags: ['message.text'] });
              } else {
                contentArr.push({ type: 'text', text: s, tags: ['message.text'] });
              }
            }
          }
        } else if (typeof src.content === 'string') {
          const s = String(src.content);
          if (s.trim().length > 0) {
            const { rest, picked } = extractTaggedPrefix(s);
          if (picked.length > 0) {
            for (const it of picked) {
              if (String(it.type).toLowerCase() === 'instructions') {
                const k = __normInstr(String(it.text || ''));
                if (k && __seenInstructions.has(k)) continue;
                if (k) __seenInstructions.add(k);
              }
              const innerTag = 'message.' + String(it.type).toLowerCase();
              const containerTag = 'message.text';
              contentArr.push({ ...it, tags: Array.from(new Set([...(it.tags || []), innerTag, containerTag])) });
            }
            if (rest.trim().length > 0) contentArr.push({ type: 'text', text: rest, tags: ['message.text'] });
          }
            else contentArr.push({ type: 'text', text: s, tags: ['message.text'] });
          }
        }
        // 兼容部分日志：无 content，但存在 input_text/output_text 字段
        if (contentArr.length === 0) {
          try {
            const hasInput = typeof (src as any).input_text === 'string' && String((src as any).input_text).length > 0;
            const hasOutput = !hasInput && typeof (src as any).output_text === 'string' && String((src as any).output_text).length > 0;
            const it = String(hasInput ? (src as any).input_text : (hasOutput ? (src as any).output_text : ''));
            const containerTag = hasInput ? 'message.input_text' : (hasOutput ? 'message.output_text' : 'message.text');
            if (it.trim().length > 0) {
              const { rest, picked } = extractTaggedPrefix(it);
              if (picked.length > 0) {
                for (const it2 of picked) {
                  if (String(it2.type).toLowerCase() === 'instructions') {
                    const k = __normInstr(String(it2.text || ''));
                    if (k && __seenInstructions.has(k)) continue;
                    if (k) __seenInstructions.add(k);
                  }
                  const innerTag = 'message.' + String(it2.type).toLowerCase();
                  contentArr.push({ ...it2, tags: Array.from(new Set([...(it2.tags || []), innerTag, containerTag])) });
                }
                if (rest.trim().length > 0) contentArr.push({ type: hasInput ? 'input_text' : (hasOutput ? 'output_text' : 'text'), text: rest, tags: [containerTag] });
              } else {
                contentArr.push({ type: hasInput ? 'input_text' : (hasOutput ? 'output_text' : 'text'), text: it, tags: [containerTag] });
              }
            }
          } catch {}
        }
        if (contentArr.length > 0) messages.push({ role, content: contentArr });
      } else if (obj.type === 'function_call' || (obj.type === 'response_item' && obj.payload && obj.payload.type === 'function_call')) {
        // 工具/函数调用
        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
        const name = src.name || src.tool || src.function || 'function';
        let argsPretty = '';
        try {
          if (typeof src.arguments === 'string') {
            try { argsPretty = JSON.stringify(JSON.parse(src.arguments), null, 2); }
            catch { argsPretty = src.arguments; }
          } else if (src.arguments) {
            argsPretty = JSON.stringify(src.arguments, null, 2);
          }
        } catch {}
        const text = `name: ${name}\n${argsPretty ? 'arguments:\n' + argsPretty : ''}${(src as any).call_id ? `\ncall_id: ${(src as any).call_id}` : ''}`.trim();
        messages.push({ role: 'tool', content: [{ type: 'function_call', text, tags: ['function_call'] }] });
      } else if (obj.type === 'function_call_output' || (obj.type === 'response_item' && obj.payload && obj.payload.type === 'function_call_output')) {
        // 工具输出
        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
        let out = '';
        try {
          if (typeof src.output === 'string') {
            // 某些日志将整个对象 JSON 作为字符串包裹
            try { out = JSON.stringify(JSON.parse(src.output), null, 2); }
            catch { out = src.output; }
          } else if (src.output) {
            out = JSON.stringify(src.output, null, 2);
          }
        } catch {}
        const meta = (src as any).metadata ? `\nmetadata:\n${pretty((src as any).metadata)}` : '';
        const text = `${out}${meta}`.trim();
        messages.push({ role: 'tool', content: [{ type: 'function_output', text, tags: ['function_output'] }] });
      } else if (obj.type === 'reasoning' || (obj.type === 'response_item' && obj.payload && obj.payload.type === 'reasoning')) {
        // 仅展示公开的 summary，忽略/标注加密内容
        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
        const items: MessageContent[] = [];
        try {
          if (Array.isArray(src.summary)) {
            for (const s of src.summary) {
              if (!s) continue;
              const t = s.text ?? s.summary_text ?? '';
              if (t && String(t).trim().length > 0) items.push({ type: 'summary', text: String(t), tags: ['reasoning.summary'] });
            }
          }
          if (src.encrypted_content) {
            items.push({ type: 'summary', text: '[encrypted_reasoning omitted]', tags: ['reasoning.summary'] });
          }
        } catch {}
        if (items.length > 0) messages.push({ role: 'reasoning', content: items });
      } else if (obj.record_type === 'state' || obj.type === 'state' || (obj.type === 'response_item' && obj.payload && (obj.payload.type === 'state' || obj.payload.record_type === 'state'))) {
        const role = 'state';
        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
        messages.push({ role, content: [{ type: 'state', text: JSON.stringify(src), tags: ['state'] }] });
      } else if (isSessionHeader) {
        // 会话元信息分类：避免被归为 unknown，并集中展示关键信息
        try {
          const meta = {
            id: obj.id,
            timestamp: obj.timestamp,
            git: obj.git,
          };
          messages.push({ role: 'meta', content: [{ type: 'session_meta', text: pretty(meta) }] });
        } catch {
          // fallback to unknown if stringify fails
          messages.push({ role: String(obj.role || obj.type || 'unknown'), content: [{ type: String(obj.type || 'unknown'), text: pretty(obj) }] });
        }
      } else {
        // 未识别类型：完整保留对象，避免信息遗漏
        messages.push({ role: String(obj.role || obj.type || 'unknown'), content: [{ type: String(obj.type || 'unknown'), text: pretty(obj) }] });
      }
    } catch (e) {
      skipped++;
    }
    return lineIndex + 1;
  }

  // 改为统一使用 UNC/Windows 直读，不再通过 wsl 调用读取

  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(filePath)) return resolve({ id, title, date, messages, skippedLines: 0 });
      const rs = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: chunk });
      const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
      let lineIndex = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { rl.close(); } catch {}
        try { rs.destroy(); } catch {}
        const result = { id, title, date: (stat?.mtimeMs || Date.now()), messages, skippedLines: skipped };
        try {
          if (stat) {
            const key = filePath;
            // 简单 LRU：超过 200 条时清理前 50 条
            if (cache.size > 200) {
              let i = 0;
              for (const k of cache.keys()) { cache.delete(k); if (++i >= 50) break; }
            }
            cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, result });
          }
        } catch {}
        resolve(result);
      };
      const fail = (err: any) => {
        if (done) return;
        done = true;
        try { rl.close(); } catch {}
        try { rs.destroy(); } catch {}
        reject(err);
      };
      rl.on('line', (line) => {
        if (done) return;
        lineIndex = parseLine(line, lineIndex);
        if (lineIndex >= maxLines) {
          finish();
        }
      });
      rl.on('close', () => {
        finish();
      });
      rl.on('error', (err) => {
        fail(err);
      });
      rs.on('end', () => {
        // 某些平台上不会触发 rl 'close'，监听底层 end 以兜底
        finish();
      });
      rs.on('error', (err) => {
        fail(err);
      });
    } catch (err) {
      // fs 读取初始化失败，返回空结构
      const result = { id, title, date: (stat?.mtimeMs || Date.now()), messages, skippedLines: skipped };
      try {
        if (stat) {
          const key = filePath;
          if (cache.size > 200) {
            let i = 0;
            for (const k of cache.keys()) { cache.delete(k); if (++i >= 50) break; }
          }
          cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, result });
        }
      } catch {}
      resolve(result);
    }
  });
}

// ---------------------------
// New: Persistent Index + Details Cache + Background Indexer
// ---------------------------


export async function removePathFromCache(filePath: string) {
  try {
    const all = loadHistoryCache();
    let changed = false;
    const cleaned = (all || []).map((e) => {
      const before = Array.isArray(e.list) ? e.list.length : 0;
      const list = (e.list || []).filter((item) => String(item.filePath) !== String(filePath));
      if (list.length !== before) changed = true;
      return { ...e, list } as HistoryListCacheEntry;
    });
    if (changed) saveHistoryCache(cleaned);
  } catch {}
}

export default { listHistory, readHistoryFile, computeHistoryRoots, debugInfo, removePathFromCache };
