// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import { perfLogger } from "./log";
import { getDebugConfig } from "./debugConfig";
import { getSessionsRootCandidatesFastAsync, isUNCPath, uncToWsl } from "./wsl";
import { safeWindowSend } from "./ipcSafe";
import { detectResumeInfo, detectRuntimeShell, detectRuntimeShellFromContent } from "./history";
import type { HistorySummary, Message, RuntimeShell } from "./history";
import settings from "./settings";
import { getClaudeRootCandidatesFastAsync, discoverClaudeSessionFiles } from "./agentSessions/claude/discovery";
import { getGeminiRootCandidatesFastAsync, discoverGeminiSessionFiles } from "./agentSessions/gemini/discovery";
import { parseClaudeSessionFile } from "./agentSessions/claude/parser";
import { parseGeminiSessionFile, deriveGeminiProjectHashCandidatesFromPath } from "./agentSessions/gemini/parser";
import { filterHistoryPreviewText } from "./agentSessions/shared/preview";

// 仅在存在时使用 chokidar；否则跳过监听
let chokidar: any = null;
try { chokidar = require("chokidar"); } catch {}

type ProviderId = "codex" | "claude" | "gemini";
type FileSig = { mtimeMs: number; size: number };
type IndexSummary = HistorySummary & { providerId: ProviderId; dirKey: string };
type Details = {
  providerId: ProviderId;
  id: string;
  title: string;
  date: number;
  filePath: string;
  messages: Message[];
  skippedLines?: number;
  rawDate?: string;
  cwd?: string;
  dirKey?: string;
  preview?: string;
  resumeMode?: 'modern' | 'legacy' | 'unknown';
  resumeId?: string;
  runtimeShell?: RuntimeShell;
};

type PersistIndex = {
  version: string;
  files: Record<string, { sig: FileSig; summary: IndexSummary }>; // filePath -> summary
  savedAt: number;
};

type PersistDetails = {
  version: string;
  files: Record<string, { sig: FileSig; details: Details }>;
  savedAt: number;
};

// 单次偏好的详情缓存大小：保留最近查看的几条，防止无限增长
const DETAILS_CACHE_LIMIT = 8;

const g: any = global as any;
if (!g.__indexer) g.__indexer = {};
if (!g.__indexer.retries) g.__indexer.retries = new Map<string, { count: number; timer?: NodeJS.Timeout }>();
// 周期性重扫的节流参数：避免频繁解析大文件导致内存/CPU 激增
const RESCAN_INTERVAL_MS = 60_000;
const RESCAN_COOLDOWN_MS = 30_000;
const RESCAN_COOLDOWN_MAX = 512;

// Watch 去抖/批处理：避免 Claude 等 CLI 启动阶段频繁写入触发重复解析，导致主进程 CPU/内存瞬时飙升
const WATCH_DEBOUNCE_MS = 800;
const WATCH_BATCH_LIMIT = 48;
const WATCH_CONCURRENCY = 2;

type WatchQueueEntry = { filePath: string; dueAt: number };
type WatchQueueState = { timer: NodeJS.Timeout | null; flushing: boolean; queue: Map<string, WatchQueueEntry> };

/**
 * 获取文件变更监听的队列状态（挂到 global.__indexer，便于 stopHistoryIndexer 统一清理）。
 */
function getWatchQueueState(): WatchQueueState {
  if (!g.__indexer) g.__indexer = {};
  if (!g.__indexer.watchQueueState) {
    g.__indexer.watchQueueState = { timer: null, flushing: false, queue: new Map<string, WatchQueueEntry>() } as WatchQueueState;
  }
  return g.__indexer.watchQueueState as WatchQueueState;
}

/**
 * 清理文件变更监听队列（防止重启索引器后残留定时器/闭包）。
 */
function clearWatchQueueState(): void {
  try {
    const st = (g.__indexer && g.__indexer.watchQueueState) ? (g.__indexer.watchQueueState as WatchQueueState) : null;
    if (st?.timer) {
      try { clearTimeout(st.timer); } catch {}
    }
  } catch {}
  try {
    if (!g.__indexer) g.__indexer = {};
    g.__indexer.watchQueueState = { timer: null, flushing: false, queue: new Map<string, WatchQueueEntry>() } as WatchQueueState;
  } catch {}
}

function getRescanCooldownMap(): Map<string, number> {
  if (!g.__indexer) g.__indexer = {};
  if (!g.__indexer.rescanCooldown) g.__indexer.rescanCooldown = new Map<string, number>();
  return g.__indexer.rescanCooldown as Map<string, number>;
}

function shouldThrottleRescan(key: string, now: number): boolean {
  try {
    const last = getRescanCooldownMap().get(key);
    return typeof last === "number" && now - last < RESCAN_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markRescanCooldown(key: string, now: number): void {
  try {
    const map = getRescanCooldownMap();
    map.set(key, now);
    while (map.size > RESCAN_COOLDOWN_MAX) {
      const first = map.keys().next().value as string | undefined;
      if (!first) break;
      map.delete(first);
    }
  } catch {}
}

function clearRescanCooldown(): void {
  try { getRescanCooldownMap().clear(); } catch {}
}

function stripDetailsForPersist(details: Details): Details {
  const { messages, ...rest } = details as Details & { messages?: Message[] };
  return { ...rest, messages: [] };
}

const VERSION = "v8";

/**
 * 读取 Claude Code 的 Agent 历史开关（默认 false）。
 */
function getClaudeCodeReadAgentHistorySetting(): boolean {
  try {
    return !!(settings.getSettings() as any)?.claudeCode?.readAgentHistory;
  } catch {
    return false;
  }
}

/**
 * 判断是否为 Claude Code 的 Agent 历史文件（agent-*.jsonl）。
 */
function isClaudeAgentHistoryFilePath(filePath: string): boolean {
  try {
    const base = path.basename(String(filePath || "")).toLowerCase();
    return base.startsWith("agent-") && base.endsWith(".jsonl");
  } catch {
    return false;
  }
}

/**
 * 默认过滤：判断 Claude 会话是否应被忽略（不读取/不缓存）。
 */
function shouldIgnoreClaudeSession(details: { filePath?: string; title?: string; preview?: string }, includeAgentHistory: boolean): boolean {
  if (includeAgentHistory) return false;
  try {
    if (isClaudeAgentHistoryFilePath(String(details?.filePath || ""))) return true;
    const preview = typeof details?.preview === "string" ? details.preview.trim() : "";
    if (preview) return false;
    const fp = String(details?.filePath || "");
    const base = fp ? path.basename(fp) : "";
    const title = typeof details?.title === "string" ? details.title : "";
    // 仅当“标题=文件名 且无 preview”时，判定为仅包含助手输出的记录（无用户输入）。
    return !!base && (!title || title === base);
  } catch {
    return false;
  }
}

function getUserDataDir(): string {
  try { const { app } = require("electron"); return app.getPath("userData"); } catch { return process.cwd(); }
}

function indexPath(): string { return path.join(getUserDataDir(), `history.index.${VERSION}.json`); }
function detailsPath(): string { return path.join(getUserDataDir(), `history.details.${VERSION}.json`); }
function purgeLegacyPersistFiles(): void {
  try {
    const dir = getUserDataDir();
    const files = fs.readdirSync(dir);
    for (const fileName of files) {
      if (!/^history\.(?:index|details)\.v\d+\.json$/i.test(fileName)) continue;
      if (fileName.endsWith(`.v${VERSION}.json`)) continue;
      try { fs.rmSync(path.join(dir, fileName), { force: true }); } catch {}
    }
  } catch {}
}

// ---- Minimal debug (opt-in) ----
function idxDbgEnabled(): boolean { try { return !!getDebugConfig().indexer.debug; } catch { return false; } }
function idxDbgMatch(fp: string): boolean { try { const sub = String(getDebugConfig().indexer.filter || '').trim(); if (!sub) return true; return String(fp || '').toLowerCase().includes(sub.toLowerCase()); } catch { return true; } }
function idxLog(msg: string) {
  if (!idxDbgEnabled()) return;
  try {
    const line = `${new Date().toISOString()} [INDEXER] ${msg}\n`;
    const { app } = require('electron');
    fs.appendFileSync(path.join(app.getPath('userData'), 'indexer-debug.log'), line, 'utf8');
  } catch {}
}

function loadIndex(): PersistIndex {
  try {
    const p = indexPath();
    if (!fs.existsSync(p)) return { version: VERSION, files: {}, savedAt: 0 };
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    return { version: VERSION, files: obj.files || {}, savedAt: Number(obj.savedAt || 0) } as PersistIndex;
  } catch { return { version: VERSION, files: {}, savedAt: 0 }; }
}

function saveIndex(ix: PersistIndex) {
  try { fs.writeFileSync(indexPath(), JSON.stringify(ix, null, 2), "utf8"); } catch {}
}

function loadDetails(): PersistDetails {
  try {
    const p = detailsPath();
    if (!fs.existsSync(p)) return { version: VERSION, files: {}, savedAt: 0 };
    const obj = JSON.parse(fs.readFileSync(p, "utf8")) as any;
    const normalized: PersistDetails = { version: VERSION, files: {}, savedAt: Number(obj.savedAt || 0) };
    let trimmed = false;
    const files = (obj && obj.files) ? obj.files as Record<string, { sig: FileSig; details: Details }> : {};
    for (const [k, entry] of Object.entries(files)) {
      if (!entry || !entry.details || !entry.sig) continue;
      const slim = stripDetailsForPersist(entry.details);
      if (Array.isArray((entry.details as any).messages) && (entry.details as any).messages.length > 0) {
        trimmed = true;
      }
      normalized.files[k] = { sig: entry.sig, details: slim };
    }
    if (trimmed) {
      try { saveDetails(normalized); } catch {}
    }
    return normalized;
  } catch { return { version: VERSION, files: {}, savedAt: 0 }; }
}

function saveDetails(d: PersistDetails) {
  try {
    const normalized: PersistDetails = { version: VERSION, files: {}, savedAt: Number(d.savedAt || Date.now()) };
    const entries = d.files || {};
    for (const [k, entry] of Object.entries(entries)) {
      if (!entry || !entry.details || !entry.sig) continue;
      normalized.files[k] = { sig: entry.sig, details: stripDetailsForPersist(entry.details) };
    }
    fs.writeFileSync(detailsPath(), JSON.stringify(normalized, null, 2), "utf8");
    d.files = normalized.files;
    d.savedAt = normalized.savedAt;
  } catch {}
}

// 并发限制器
function pLimit(max: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    running--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return function <T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        running++;
        task().then((v) => { next(); resolve(v); }).catch((e) => { next(); reject(e); });
      };
      if (running < max) run(); else queue.push(run);
    });
  };
}

function canonicalKey(filePath: string): string {
  try { return path.normalize(filePath).replace(/\\/g, "/").toLowerCase(); } catch { return String(filePath || "").toLowerCase(); }
}

function getDetailsCache(): Map<string, Details> {
  if (!g.__indexer) g.__indexer = {};
  if (!g.__indexer.detailsCache) g.__indexer.detailsCache = new Map<string, Details>();
  return g.__indexer.detailsCache as Map<string, Details>;
}

export function cacheDetails(filePath: string, details: Details): void {
  try {
    if (!details || !Array.isArray(details.messages) || details.messages.length === 0) return;
    const cache = getDetailsCache();
    const key = canonicalKey(filePath);
    const shell = details.runtimeShell && details.runtimeShell !== "unknown" ? details.runtimeShell : detectRuntimeShell(filePath);
    const normalized: Details = { ...details, runtimeShell: shell };
    cache.delete(key);
    cache.set(key, normalized);
    while (cache.size > DETAILS_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  } catch {}
}

export function getCachedDetails(filePath: string): Details | null {
  try {
    const cache = getDetailsCache();
    const key = canonicalKey(filePath);
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key);
    cache.set(key, hit);
    const shell = hit.runtimeShell && hit.runtimeShell !== "unknown" ? hit.runtimeShell : detectRuntimeShell(filePath);
    return { ...hit, runtimeShell: shell };
  } catch {
    return null;
  }
}

// 规范化/清理从日志中提取的路径候选（例如 <cwd>、"Current working directory:" 行）
function tidyPathCandidate(v?: string): string {
  try {
    if (typeof v !== 'string') return '';
    let s = v
      // 去除日志中可能残留的字面量 \n
      .replace(/\\n/g, '')
      // 去除意外包裹的引号
      .replace(/^"|"$/g, '')
      // 折叠 JSON 转义带来的双反斜杠
      .replace(/\\\\/g, '\\')
      // 去除首尾空白
      .trim()
      // 去除尾部多余分隔符
      .replace(/[\\/]+$/g, '');
    return s;
  } catch {
    return String(v || '').trim();
  }
}

// 粗略判定提取的文本是否“像路径”，用于过滤误命中的代码/注释
function isLikelyPath(p?: string): boolean {
  try {
    const s = String(p || '').trim();
    if (s.length < 2 || s.length > 512) return false;
    if (/[<>\{\};]/.test(s)) return false;
    if (/^[a-zA-Z]:\\[^\r\n\t"'<>{}|?*]+/.test(s)) return true; // 盘符
    if (/^\\\\[^\s"'\\]+\\[^\s"'\\]+/.test(s)) return true; // UNC
    if(/^\/mnt\/[a-zA-Z]\//.test(s)) return true; // /mnt/<drive>
    if(/^\/[\w._-]+\//.test(s)) return true; // 其他 POSIX 根
    return false;
  } catch { return false; }
}

function dirKeyOf(filePath: string): string {
  try {
    const d = path.dirname(filePath);
    // 归一：UNC -> WSL 风格；Windows 盘 -> /mnt/<drive>
    // 先统一斜杠，再折叠重复斜杠，避免 /mnt/c//project 之类的不一致
    const s = d.replace(/\\/g, "/");
    const s1 = s.replace(/\/+/g, "/");
    const m = s1.match(/^([a-zA-Z]):\/(.*)$/);
    if (m) return (`/mnt/${m[1].toLowerCase()}/${m[2]}`).replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
    if (isUNCPath(d)) {
      const info = uncToWsl(d);
      if (info) return info.wslPath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
    }
    return s1.replace(/\/+$/, "").toLowerCase();
  } catch { return filePath; }
}

// 从 CWD 直接计算 dirKey（不降一级）
function dirKeyFromCwd(dirPath: string): string {
  try {
    let d = tidyPathCandidate(dirPath);
    // UNC -> WSL；盘符 -> /mnt/<drive>
    if (isUNCPath(d)) {
      const info = uncToWsl(d);
      if (info) d = info.wslPath;
    } else {
      const m = d.match(/^([a-zA-Z]):\\(.*)$/);
      if (m) d = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
    }
    const s = d.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
    return s;
  } catch { return dirPath; }
}

async function readPrefix(fp: string, maxBytes = 128 * 1024): Promise<string> {
  return await new Promise((resolve) => {
    try {
      const rs = fs.createReadStream(fp, { encoding: "utf8", start: 0, end: maxBytes - 1 });
      let buf = "";
      rs.on("data", (c) => { buf += c; if (buf.length >= maxBytes) { try { rs.close(); } catch {} resolve(buf); } });
      rs.on("end", () => resolve(buf));
      rs.on("error", () => resolve(""));
    } catch { resolve(""); }
  });
}

// ------------------------------
// 预览文本过滤：跳过路径或空行，取第一段有效内容（已抽至 shared/preview）
// ------------------------------

function titleFromFilename(filePath: string): string {
  try {
    const base = path.basename(filePath).replace(/\.jsonl$/i, "");
    // 文件名示例：
    //  - rollout-2025-08-27T10-51-11-<uuid>.jsonl （旧格式）
    //  - rollout-2025-09-12T01-47-57-68647426-<uuid>.jsonl （新格式，秒后有额外序列段）
    const m = base.match(/(\d{4}-\d{2}-\d{2})[T_ ](\d{2})[-:](\d{2})[-:](\d{2})/);
    if (m) return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
    return base;
  } catch { return path.basename(filePath); }
}

async function parseSummary(fp: string, stat: fs.Stats): Promise<IndexSummary> {
  const prefix = await readPrefix(fp, 64 * 1024);
  const first = (prefix.split(/\r?\n/).find(Boolean) || "").trim();
  let id = path.basename(fp).replace(/\.jsonl$/i, "");
  let title = titleFromFilename(fp);
  let cwd: string = "";
  let rawDate: string | undefined = undefined;
  let dbgSrc: string = "";
  let resumeMode: 'modern' | 'legacy' | 'unknown' = 'unknown';
  let resumeId: string | undefined = undefined;
  let runtimeShell: RuntimeShell = 'unknown';
  let parsedFirst: any = null;
  try {
    const obj = JSON.parse(first);
    parsedFirst = obj;
    try {
      const info = detectResumeInfo(obj);
      if (info.mode) resumeMode = info.mode;
      if (info.id) resumeId = info.id;
    } catch {}
    if (obj && obj.type === 'session_meta' && obj.payload) {
      if (obj.payload?.id) id = String(obj.payload.id);
      if (typeof obj.payload?.cwd === 'string') { cwd = obj.payload.cwd; dbgSrc = 'json.payload.cwd'; }
      if (Object.prototype.hasOwnProperty.call(obj, 'timestamp')) {
        try { rawDate = String(obj.timestamp); } catch { rawDate = undefined; }
      } else if (Object.prototype.hasOwnProperty.call(obj.payload, 'timestamp')) {
        try { rawDate = String(obj.payload.timestamp); } catch { rawDate = undefined; }
      }
    } else {
      if (obj?.id) id = String(obj.id);
      if (typeof obj?.cwd === 'string') { cwd = obj.cwd; dbgSrc = 'json.cwd'; }
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'timestamp')) {
        try { rawDate = String(obj.timestamp); } catch { rawDate = undefined; }
      }
    }
  } catch {}
  const shellHint = detectRuntimeShellFromContent(parsedFirst, prefix);
  if (shellHint !== 'unknown') runtimeShell = shellHint;
  // 进一步从前缀中尝试提取 CWD
  if (!cwd) {
    try {
      // 优先使用 <cwd> 标签，避免命中代码字符串中的“Current working directory:”
      const mTag = (prefix || '').match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
      if (mTag?.[1]) {
        const cand = tidyPathCandidate(mTag[1]);
        if (isLikelyPath(cand)) { cwd = cand; dbgSrc = 'prefix.tag'; }
      }
      if (!cwd) {
        const mLine = (prefix || '').match(/Current\s+working\s+directory:\s*([^\r\n]+)/i);
        if (mLine?.[1]) {
          const cand = tidyPathCandidate(mLine[1]);
          if (isLikelyPath(cand)) { cwd = cand; dbgSrc = 'prefix.line'; }
        }
      }
    } catch {}
  }
  // 兜底：流式扫描更大范围以提取 CWD（应对前缀内未出现的情况）
  if (!cwd) {
    try {
      const fallback = await (async function extractCwdFromFile(maxScanBytes = 1024 * 1024): Promise<string> {
        try {
          const rs = fs.createReadStream(fp, { encoding: 'utf8', highWaterMark: 64 * 1024 });
          let acc = '';
          let scanned = 0;
          const reCwdTag = /<cwd>\s*([^<]+?)\s*<\/cwd>/i;
          const reCwdLine = /Current\s+working\s+directory:\s*([^\r\n]+)/i;
          return await new Promise<string>((resolve) => {
            const finish = (val: string) => { try { rs.close(); } catch {} resolve(val); };
            rs.on('data', (chunk) => {
              scanned += chunk.length;
              acc += chunk;
              // 限制 acc 长度，避免内存暴涨（保留尾部 128KB 足够跨块匹配）
              if (acc.length > 256 * 1024) acc = acc.slice(acc.length - 128 * 1024);
              const m1 = acc.match(reCwdTag);
              if (m1 && m1[1]) { const cand = tidyPathCandidate(m1[1]); if (isLikelyPath(cand)) return finish(cand); }
              const m2 = acc.match(reCwdLine);
              if (m2 && m2[1]) { const cand = tidyPathCandidate(m2[1]); if (isLikelyPath(cand)) return finish(cand); }
              if (scanned >= maxScanBytes) return finish('');
            });
            rs.on('end', () => finish(''));
            rs.on('error', () => finish(''));
          });
        } catch { return ''; }
      })();
      if (fallback) { cwd = fallback; dbgSrc = 'stream.cwd'; }
    } catch {}
  }
  // 最后兜底：在 2MB 内启发式提取任意 Windows/WSL 绝对路径
  if (!cwd) {
    try {
      const any = await (async function extractAnyPath(maxScanBytes = 1024 * 1024): Promise<string> {
        try {
          const rs = fs.createReadStream(fp, { encoding: 'utf8', highWaterMark: 64 * 1024 });
          let acc = '';
          let scanned = 0;
          // Windows 盘符路径与 /mnt/<drive>/ 路径
          const reWin = /([a-zA-Z]:\\[^\r\n\t"'<>{}]+)/;
          const reMnt = /(\/mnt\/[a-zA-Z]\/[\w\-\./]+)/;
          return await new Promise<string>((resolve) => {
            const finish = (val: string) => { try { rs.close(); } catch {} resolve(val); };
            rs.on('data', (chunk) => {
              scanned += chunk.length;
              acc += chunk;
              if (acc.length > 256 * 1024) acc = acc.slice(acc.length - 128 * 1024);
              // 优先匹配 /mnt 路径，再匹配盘符路径
              const mM = acc.match(reMnt);
              if (mM && mM[1]) return finish(tidyPathCandidate(mM[1]));
              const mW = acc.match(reWin);
              if (mW && mW[1]) return finish(tidyPathCandidate(mW[1]));
              if (scanned >= maxScanBytes) return finish('');
            });
            rs.on('end', () => finish(''));
            rs.on('error', () => finish(''));
          });
        } catch { return ''; }
      })();
      if (any) { cwd = any; dbgSrc = 'stream.any'; }
    } catch {}
  }
  // 对已获得的 cwd 做统一清理（涵盖 JSON 首行中直接给出的 cwd）
  if (cwd) cwd = tidyPathCandidate(cwd);
  const date = stat.mtimeMs || 0;
  let dirKey = "";
  if (cwd && typeof cwd === 'string') {
    dirKey = dirKeyFromCwd(String(cwd).trim());
  } else {
    // 回退：使用文件所在目录，但这可能与项目无关，仅用于兜底展示
    dirKey = dirKeyOf(fp);
    if (!dbgSrc) dbgSrc = 'fallback.filedir';
  }
  try { if (idxDbgEnabled() && idxDbgMatch(fp)) idxLog(`summary file='${fp}' id='${id}' src=${dbgSrc} cwd='${cwd}' dirKey='${dirKey}'`); } catch {}
  // 预览字段由详情解析阶段统一生成（避免与详情筛选逻辑重复/偏差）
  if (!resumeId) resumeId = id;
  if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
  return { providerId: "codex", id, title, date, filePath: fp, rawDate, dirKey, resumeMode, resumeId, runtimeShell } as any;
}

async function parseCodexDetails(fp: string, stat: fs.Stats, opts?: { summaryOnly?: boolean }): Promise<Details> {
  const summaryOnly = !!opts?.summaryOnly; // 索引阶段可跳过完整消息体，降低内存/GC 压力
  let id = path.basename(fp).replace(/\.jsonl$/i, "");
  let title = titleFromFilename(fp);
  const date = stat.mtimeMs || 0;
  const messages: Message[] = [];
  let skipped = 0;
  let rawDate: string | undefined = undefined;
  let cwd: string = "";
  let dirKey: string = "";
  let preview: string | undefined = undefined;
  let resumeMode: 'modern' | 'legacy' | 'unknown' = 'unknown';
  let resumeId: string | undefined = undefined;
  let runtimeShell: RuntimeShell = 'unknown';
  let prefixAcc: string = ""; // 前缀累积用于提取 <cwd> 或 CWD 行
  const chunk = 256 * 1024;
  // 说明类去重：会话头 instructions 与用户 <user_instructions> 可能重复
  const __seenInstructions = new Set<string>();
  const __normInstr = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pushMessage = (msg: Message) => {
    if (!summaryOnly) messages.push(msg);
  };
  return await new Promise<Details>((resolve) => {
    try {
      const rs = fs.createReadStream(fp, { encoding: "utf8", highWaterMark: chunk });
      let lineIndex = 0;
      let buf = "";

      const pretty = (v: any) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
	      const extractTaggedPrefix = (s: string) => {
	        const src = String(s || '');
	        const picked: { type: string; text: string; tags?: string[] }[] = [];
	        const leading = (src.match(/^\s*/) || [''])[0].length;
	        const s2 = src.slice(leading);
	        const lower = s2.toLowerCase();
	        const openU = '<user_instructions>';
	        const closeU = '</user_instructions>';
	        const openP = '<permissions instructions>';
	        const closeP = '</permissions instructions>';
	        const openE = '<environment_context>';
	        const closeE = '</environment_context>';
	        if (lower.startsWith(openU)) {
	          const idx = lower.indexOf(closeU);
	          if (idx >= 0) {
	            const inner = s2.slice(openU.length, idx);
	            picked.push({ type: 'instructions', text: inner });
	            const rest = s2.slice(idx + closeU.length);
	            return { rest: rest.trim(), picked };
	          }
	          picked.push({ type: 'instructions', text: s2.slice(openU.length) });
	          return { rest: '', picked };
	        }
	        // 匹配 permissions instructions 前缀（用于沙盒/审批策略等运行权限说明）
	        if (lower.startsWith(openP)) {
	          const idx = lower.indexOf(closeP);
	          if (idx >= 0) {
	            const inner = s2.slice(openP.length, idx);
	            picked.push({ type: 'instructions', text: inner });
	            const rest = s2.slice(idx + closeP.length);
	            return { rest: rest.trim(), picked };
	          }
	          picked.push({ type: 'instructions', text: s2.slice(openP.length) });
	          return { rest: '', picked };
	        }
	        if (lower.startsWith(openE)) {
	          const idx = lower.indexOf(closeE);
	          if (idx >= 0) {
	            const inner = s2.slice(openE.length, idx);
	            picked.push({ type: 'environment_context', text: inner });
            const rest = s2.slice(idx + closeE.length);
            return { rest: rest.trim(), picked };
          }
          picked.push({ type: 'environment_context', text: s2.slice(openE.length) });
          return { rest: '', picked };
        }
        const agentsPrefix = '# agents.md instructions for';
        if (lower.startsWith(agentsPrefix)) {
          const openTag = '<instructions>';
          const closeTag = '</instructions>';
          const openIdx = lower.indexOf(openTag);
          if (openIdx >= 0) {
            const closeIdx = lower.indexOf(closeTag, openIdx + openTag.length);
            if (closeIdx >= 0) {
              const inner = s2.slice(openIdx + openTag.length, closeIdx);
              picked.push({ type: 'instructions', text: inner });
              const rest = s2.slice(closeIdx + closeTag.length);
              return { rest: rest.trim(), picked };
            }
          }
          const afterHeader = s2.split(/\r?\n/).slice(1).join('\n').trim();
          if (afterHeader) {
            picked.push({ type: 'instructions', text: afterHeader });
            return { rest: '', picked };
          }
          picked.push({ type: 'instructions', text: s2 });
          return { rest: '', picked };
        }
        return { rest: src, picked };
      };
      const flushLines = (text: string) => {
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (runtimeShell === 'unknown') {
              const hint = detectRuntimeShellFromContent(obj, prefixAcc);
              if (hint !== 'unknown') runtimeShell = hint;
            }
            if (lineIndex === 0) {
              try {
                const info = detectResumeInfo(obj);
                if (info.mode) resumeMode = info.mode;
                if (info.id) resumeId = info.id;
              } catch {}
              try {
                if ((obj as any).type === 'session_meta' && (obj as any).payload) {
                  const payload = (obj as any).payload || {};
                  if (payload.id) id = String(payload.id);
                  if (Object.prototype.hasOwnProperty.call(obj, 'timestamp')) {
                    try { rawDate = String((obj as any).timestamp); } catch { rawDate = undefined; }
                  } else if (Object.prototype.hasOwnProperty.call(payload, 'timestamp')) {
                    try { rawDate = String(payload.timestamp); } catch { rawDate = undefined; }
                  }
                  // 若首行带 cwd 线索，直接采集
                  try {
                    const cand = tidyPathCandidate(String(payload.cwd || ''));
                    if (cand && isLikelyPath(cand)) cwd = cand;
                  } catch {}
                  if (typeof payload.instructions === 'string' && payload.instructions.trim().length > 0) {
                    const t = String(payload.instructions);
                    const k = __normInstr(t);
                    if (!__seenInstructions.has(k)) {
                      __seenInstructions.add(k);
                      pushMessage({ role: 'system', content: [{ type: 'instructions', text: t, tags: ['session_meta.instructions','session_instructions','instructions'] as any }] });
                    }
                  }
                  if (payload.git) {
                    pushMessage({ role: 'state', content: [{ type: 'git', text: pretty(payload.git), tags: ['session_meta.git'] as any }] });
                  }
                } else {
                  if (obj.id) id = String(obj.id);
                  if ((obj as any).instructions || (obj as any).title) title = String((obj as any).instructions || (obj as any).title);
                  if (Object.prototype.hasOwnProperty.call(obj, 'timestamp')) {
                    try { rawDate = String((obj as any).timestamp); } catch { rawDate = undefined; }
                  }
                  // 若首行带 cwd 线索，直接采集
                  try {
                    const cand = tidyPathCandidate(String((obj as any).cwd || ''));
                    if (cand && isLikelyPath(cand)) cwd = cand;
                  } catch {}
                  if (typeof (obj as any).instructions === 'string' && (obj as any).instructions.trim().length > 0) {
                    const t = String((obj as any).instructions);
                    const k = __normInstr(t);
                    if (!__seenInstructions.has(k)) {
                      __seenInstructions.add(k);
                      pushMessage({ role: 'system', content: [{ type: 'instructions', text: t, tags: ['session_instructions','instructions'] as any }] });
                    }
                  }
                  if ((obj as any).git) {
                    pushMessage({ role: 'state', content: [{ type: 'git', text: pretty((obj as any).git) }] });
                  }
                }
              } catch {}
            }
            // 兼容新旧头格式：不强制要求 instructions 存在
            const isSessionHeader = (
              obj && typeof obj === 'object' &&
              !obj.type && !obj.record_type &&
              Object.prototype.hasOwnProperty.call(obj, 'id') &&
              Object.prototype.hasOwnProperty.call(obj, 'timestamp')
            );
            if (obj.type === 'message' || obj.record_type === 'message' || ((obj as any).type === 'response_item' && (obj as any).payload && (((obj as any).payload.type === 'message') || ((obj as any).payload.record_type === 'message')))) {
              const src: any = ((obj as any).type === 'response_item' && (obj as any).payload) ? (obj as any).payload : obj;
              const role = String(src.role || src.actor || src.from || 'user');
              const items: { type: string; text: string; tags?: string[] }[] = [];
              if (Array.isArray(src.content)) {
                for (const c of src.content) {
                  if (!c) continue;
                  const t = c?.text ?? c?.code ?? (c?.payload ? pretty(c.payload) : '');
                  if (typeof t !== 'string' || t.trim().length === 0) continue;
                  const ctype = String(c?.type || 'text').toLowerCase();
                  if (ctype === 'input_text' || ctype === 'text') {
                    const { rest, picked } = extractTaggedPrefix(String(t));
                    if (picked.length > 0) {
                      for (const it of picked) {
                        if (String((it as any).type || '').toLowerCase() === 'instructions') {
                          const k = __normInstr(String((it as any).text || ''));
                          if (k && __seenInstructions.has(k)) continue;
                          if (k) __seenInstructions.add(k);
                        }
                        const innerTag = 'message.' + String((it as any).type || 'text').toLowerCase();
                        const containerTag = 'message.' + String(c?.type || 'text').toLowerCase();
                        items.push({ ...(it as any), tags: Array.from(new Set([...(it as any).tags || [], innerTag, containerTag])) } as any);
                      }
                      if (rest.trim().length > 0) items.push({ type: String(c?.type || 'text'), text: rest, tags: ['message.' + String(c?.type || 'text').toLowerCase()] as any });
                    }
                    else items.push({ type: String(c?.type || 'text'), text: String(t), tags: ['message.' + String(c?.type || 'text').toLowerCase()] as any });
                  } else {
                    items.push({ type: String(c?.type || 'text'), text: String(t), tags: ['message.' + String(c?.type || 'text').toLowerCase()] as any });
                  }
                }
              } else if (typeof src.content === 'string') {
                const { rest, picked } = extractTaggedPrefix(String(src.content));
                if (picked.length > 0) {
                  for (const it of picked) {
                    if (String((it as any).type || '').toLowerCase() === 'instructions') {
                      const k = __normInstr(String((it as any).text || ''));
                      if (k && __seenInstructions.has(k)) continue;
                      if (k) __seenInstructions.add(k);
                    }
                    const innerTag = 'message.' + String((it as any).type || 'text').toLowerCase();
                    const containerTag = 'message.text';
                    items.push({ ...(it as any), tags: Array.from(new Set([...(it as any).tags || [], innerTag, containerTag])) } as any);
                  }
                  if (rest.trim().length > 0) items.push({ type: 'text', text: rest, tags: ['message.text'] as any });
                }
                else items.push({ type: 'text', text: String(src.content), tags: ['message.text'] as any });
              }
              if (items.length) {
                // 在构建 items 后，零额外遍历地捕获首条用户 input_text 的预览（排除说明类）
                if (!preview && String(role).toLowerCase() === 'user') {
                  for (const it of items) {
                    const ty = String((it as any)?.type || '').toLowerCase();
                    if (ty === 'instructions' || ty === 'environment_context') continue;
                    if (ty === 'input_text') {
                      const t = String((it as any)?.text || '').trim();
                      if (t) {
                        // 预览行级过滤：跳过路径/空行，直到遇到有效内容
                        const filtered = filterHistoryPreviewText(t);
                        if (filtered) { preview = filtered.slice(0, 40); break; }
                      }
                    }
                  }
                  if (!preview) {
                    for (const it of items) {
                      const ty = String((it as any)?.type || '').toLowerCase();
                      if (ty === 'instructions' || ty === 'environment_context') continue;
                      const t = String((it as any)?.text || '').trim();
                      if (t) {
                        const filtered = filterHistoryPreviewText(t);
                        if (filtered) { preview = filtered.slice(0, 40); break; }
                      }
                    }
                  }
                }
                // 额外：某些 CLI 会把 <cwd> 或 "Current working directory:" 放在 message content 中，优先提取
                if (!cwd) {
                  try {
                    for (const it of items) {
                      const ty = String((it as any)?.type || '').toLowerCase();
                      const text = String((it as any)?.text || '');
                      if (!text) continue;
                      if (ty === 'environment_context' || ty === 'text' || ty === 'input_text') {
                        const mTag = text.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
                        if (mTag && mTag[1]) {
                          const cand = tidyPathCandidate(mTag[1]);
                          if (isLikelyPath(cand)) { cwd = cand; idxLog(`parseDetails: cwd found in message tag='${cand}' file='${fp}'`); break; }
                        }
                        const mLine = text.match(/Current\s+working\s+directory:\s*([^\r\n]+)/i);
                        if (mLine && mLine[1]) {
                          const cand = tidyPathCandidate(mLine[1]);
                          if (isLikelyPath(cand)) { cwd = cand; idxLog(`parseDetails: cwd found in message line='${cand}' file='${fp}'`); break; }
                        }
                      }
                    }
                  } catch {}
                }
                pushMessage({ role, content: items });
              }
            } else if (obj.type === 'function_call' || obj.record_type === 'tool_call' || ((obj as any).type === 'response_item' && (obj as any).payload && (((obj as any).payload.type === 'function_call') || ((obj as any).payload.record_type === 'tool_call')))) {
              const src: any = ((obj as any).type === 'response_item' && (obj as any).payload) ? (obj as any).payload : obj;
              const name = src.name || src.tool || src.function || 'function';
              let argsPretty = '';
              try {
                if (typeof src.arguments === 'string') {
                  try { argsPretty = JSON.stringify(JSON.parse(src.arguments), null, 2); } catch { argsPretty = src.arguments; }
                } else if (src.arguments) {
                  argsPretty = JSON.stringify(src.arguments, null, 2);
                } else if (obj.input) {
                  argsPretty = pretty(obj.input);
                }
              } catch {}
              const text = `name: ${name}\n${argsPretty ? 'arguments:\n' + argsPretty : ''}${(src as any).call_id ? `\ncall_id: ${(src as any).call_id}` : ''}`.trim();
              pushMessage({ role: 'tool', content: [{ type: 'function_call', text, tags: ['function_call'] as any }] });
            } else if (obj.type === 'function_call_output' || ((obj as any).type === 'response_item' && (obj as any).payload && (obj as any).payload.type === 'function_call_output')) {
              let out = '';
              try {
                const src: any = ((obj as any).type === 'response_item' && (obj as any).payload) ? (obj as any).payload : obj;
                if (typeof src.output === 'string') {
                  try { out = JSON.stringify(JSON.parse(src.output), null, 2); } catch { out = src.output; }
                } else if (src.output) { out = JSON.stringify(src.output, null, 2); }
              } catch {}
              const meta = (obj as any).metadata ? `\nmetadata:\n${pretty((obj as any).metadata)}` : '';
              const text = `${out}${meta}`.trim();
              pushMessage({ role: 'tool', content: [{ type: 'function_output', text, tags: ['function_output'] as any }] });
            } else if (obj.type === 'reasoning' || ((obj as any).type === 'response_item' && (obj as any).payload && (obj as any).payload.type === 'reasoning')) {
              const items: { type: string; text: string; tags?: string[] }[] = [];
              try {
                const src: any = ((obj as any).type === 'response_item' && (obj as any).payload) ? (obj as any).payload : obj;
                if (Array.isArray(src.summary)) {
                  for (const s of src.summary) {
                    const t = s?.text ?? s?.summary_text ?? '';
                    if (t && String(t).trim().length > 0) items.push({ type: 'summary', text: String(t), tags: ['reasoning.summary'] as any });
                  }
                }
                if ((src as any).encrypted_content) items.push({ type: 'summary', text: '[encrypted_reasoning omitted]', tags: ['reasoning.summary'] as any });
              } catch {}
              if (items.length) pushMessage({ role: 'reasoning', content: items });
            } else if (obj.type === 'state' || obj.record_type === 'state' || ((obj as any).type === 'response_item' && (obj as any).payload && (((obj as any).payload.type === 'state') || ((obj as any).payload.record_type === 'state')))) {
              const src: any = ((obj as any).type === 'response_item' && (obj as any).payload) ? (obj as any).payload : obj;
              pushMessage({ role: 'state', content: [{ type: 'state', text: JSON.stringify(src), tags: ['state'] as any }] });
            } else if (isSessionHeader) {
              const meta = { id: obj.id, timestamp: obj.timestamp, git: obj.git };
              pushMessage({ role: 'meta', content: [{ type: 'session_meta', text: pretty(meta) }] });
            } else {
              pushMessage({ role: String(obj.role || obj.type || 'unknown'), content: [{ type: String(obj.type || 'unknown'), text: pretty(obj) }] });
            }
          } catch { skipped++; }
          lineIndex++;
        }
      };

      rs.on('data', (c) => {
        buf += c;
        prefixAcc += c;
        if (prefixAcc.length > 128 * 1024) prefixAcc = prefixAcc.slice(prefixAcc.length - 128 * 1024);
        if (runtimeShell === 'unknown') {
          const hint = detectRuntimeShellFromContent(undefined, prefixAcc);
          if (hint !== 'unknown') runtimeShell = hint;
        }
        const i = buf.lastIndexOf('\n');
        if (i >= 0) {
          const seg = buf.slice(0, i);
          buf = buf.slice(i + 1);
          flushLines(seg);
        }
      });
      rs.on('end', () => {
        if (buf) flushLines(buf);
        // 从前缀累积中提取 CWD（仅一次正则匹配）
        try {
          if (!cwd) {
            const mTag = (prefixAcc || '').match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
            if (mTag && mTag[1]) {
              const cand = tidyPathCandidate(mTag[1]);
              if (isLikelyPath(cand)) cwd = cand;
            }
          }
          if (!cwd) {
            const mLine = (prefixAcc || '').match(/Current\s+working\s+directory:\s*([^\r\n]+)/i);
            if (mLine && mLine[1]) {
              const cand = tidyPathCandidate(mLine[1]);
              if (isLikelyPath(cand)) cwd = cand;
            }
          }
          // 兜底：在已累积的前缀中启发式提取任意绝对路径（Windows 盘符或 /mnt/<drive>），用于匹配项目
          if (!cwd) {
            const reWin = /([a-zA-Z]:\\[^\r\n\t"'<>\{\}|?*]+)/;
            const reMnt = /(\/mnt\/[a-zA-Z]\/[^\s"'<>]+)/;
            const mM = (prefixAcc || '').match(reMnt);
            if (mM && mM[1]) {
              const cand = tidyPathCandidate(mM[1]);
              if (isLikelyPath(cand)) cwd = cand;
            }
            if (!cwd) {
              const mW = (prefixAcc || '').match(reWin);
              if (mW && mW[1]) {
                const cand = tidyPathCandidate(mW[1]);
                if (isLikelyPath(cand)) cwd = cand;
              }
            }
          }
        } catch {}
        if (cwd) dirKey = dirKeyFromCwd(cwd); else dirKey = dirKeyOf(fp);
        if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
        const finalResumeId = resumeId || id;
        resolve({ providerId: "codex", id, title, date, filePath: fp, messages, skippedLines: skipped, rawDate, cwd, dirKey, preview, resumeMode, resumeId: finalResumeId, runtimeShell });
      });
      rs.on('error', () => {
        if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
        const finalResumeId = resumeId || id;
        resolve({ providerId: "codex", id, title, date, filePath: fp, messages, skippedLines: skipped, rawDate, cwd, dirKey, preview, resumeMode, resumeId: finalResumeId, runtimeShell });
      });
    } catch {
      if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
      const finalResumeId = resumeId || id;
      resolve({ providerId: "codex", id, title, date, filePath: fp, messages, skippedLines: skipped, resumeMode, resumeId: finalResumeId, runtimeShell });
    }
  });
}

// 全局索引状态在文件头部初始化

export function getIndexedSummaries(): IndexSummary[] {
  const ix: PersistIndex = g.__indexer.index || { version: VERSION, files: {}, savedAt: 0 };
  return Object.values(ix.files)
    .map((x) => {
      const summary = x.summary as any;
      const providerId: ProviderId = (summary && typeof summary.providerId === "string")
        ? (summary.providerId as ProviderId)
        : "codex";
      const shell = summary.runtimeShell && summary.runtimeShell !== 'unknown' ? summary.runtimeShell : detectRuntimeShell(summary.filePath);
      return { ...summary, providerId, runtimeShell: shell } as IndexSummary;
    })
    .sort((a, b) => b.date - a.date);
}

export function getIndexedDetails(filePath: string): Details | null {
  const cached = getCachedDetails(filePath);
  if (cached) return cached;
  const det: PersistDetails = g.__indexer.details || { version: VERSION, files: {}, savedAt: 0 };
  const k = canonicalKey(filePath);
  const v = det.files[k]?.details;
  if (!v || !Array.isArray(v.messages) || v.messages.length === 0) return null;
  const shell = v.runtimeShell && v.runtimeShell !== 'unknown' ? v.runtimeShell : detectRuntimeShell(filePath);
  const providerId: ProviderId = (v && typeof (v as any).providerId === "string") ? ((v as any).providerId as ProviderId) : "codex";
  const fp = (v && typeof (v as any).filePath === "string" && String((v as any).filePath).trim()) ? String((v as any).filePath) : filePath;
  return { ...v, providerId, filePath: fp, runtimeShell: shell };
}

export async function startHistoryIndexer(getWindow: () => BrowserWindow | null) {
  // 若被重复调用（例如调试期热重载），先停止既有 watcher/定时器，避免重复注册导致内存泄漏
  try {
    await stopHistoryIndexer();
  } catch {}
  await perfLogger.time("indexer.start", async () => {
    // 1) 读取持久化缓存
    purgeLegacyPersistFiles();
    g.__indexer.index = loadIndex();
    g.__indexer.details = loadDetails();
    try { getDetailsCache().clear(); } catch {}

    // 1.5) 读取 Claude Code 过滤开关，并在启动阶段快速清理“默认应忽略”的历史项
    const claudeCodeReadAgentHistory = getClaudeCodeReadAgentHistorySetting();
    try { (g.__indexer as any).claudeCodeReadAgentHistory = claudeCodeReadAgentHistory; } catch {}
    if (!claudeCodeReadAgentHistory) {
      try {
        const ix: PersistIndex = g.__indexer.index;
        const det: PersistDetails = g.__indexer.details;
        let removed = 0;
        for (const [k, entry] of Object.entries(ix.files || {})) {
          const summary: any = (entry as any)?.summary;
          const pid = String(summary?.providerId || "").toLowerCase();
          if (pid !== "claude") continue;
          const fp = String(summary?.filePath || "");
          const preview = typeof summary?.preview === "string" ? summary.preview.trim() : "";
          const title = typeof summary?.title === "string" ? summary.title : "";
          const base = fp ? path.basename(fp) : "";
          const assistantOnly = !preview && !!base && (!title || title === base);
          if (isClaudeAgentHistoryFilePath(fp) || assistantOnly) {
            delete ix.files[k];
            if ((det.files as any)[k]) delete (det.files as any)[k];
            removed++;
          }
        }
        if (removed > 0) {
          ix.savedAt = Date.now();
          det.savedAt = Date.now();
          saveIndex(ix);
          saveDetails(det);
          idxLog(`[purge] removed=${removed} (claude agent/assistant-only) because readAgentHistory=false`);
        }
      } catch {}
    }

    // 2) 计算根目录（不扫描）
    const codexRootCandidates = await getSessionsRootCandidatesFastAsync();
    const claudeRootCandidates = await getClaudeRootCandidatesFastAsync();
    const geminiRootCandidates = await getGeminiRootCandidatesFastAsync();

    const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
    const rootsByProviderAll: Record<ProviderId, string[]> = {
      codex: uniq(codexRootCandidates.map((c) => c.path)),
      claude: uniq(claudeRootCandidates.map((c) => c.path)),
      gemini: uniq(geminiRootCandidates.map((c) => c.path)),
    };
    const rootsByProviderExisting: Record<ProviderId, string[]> = {
      codex: uniq(codexRootCandidates.filter((c) => c.exists).map((c) => c.path)),
      claude: uniq(claudeRootCandidates.filter((c) => c.exists).map((c) => c.path)),
      gemini: uniq(geminiRootCandidates.filter((c) => c.exists).map((c) => c.path)),
    };
    const rootsByProviderMissing: Record<ProviderId, string[]> = {
      codex: uniq(codexRootCandidates.filter((c) => !c.exists).map((c) => c.path)),
      claude: uniq(claudeRootCandidates.filter((c) => !c.exists).map((c) => c.path)),
      gemini: uniq(geminiRootCandidates.filter((c) => !c.exists).map((c) => c.path)),
    };

    const rootsExisting = uniq([
      ...rootsByProviderExisting.codex,
      ...rootsByProviderExisting.claude,
      ...rootsByProviderExisting.gemini,
    ]);
    const rootsMissing = uniq([
      ...rootsByProviderMissing.codex,
      ...rootsByProviderMissing.claude,
      ...rootsByProviderMissing.gemini,
    ]);

    perfLogger.log(`[roots] codex.existing=${JSON.stringify(rootsByProviderExisting.codex)} codex.missing=${JSON.stringify(rootsByProviderMissing.codex)}`);
    perfLogger.log(`[roots] claude.existing=${JSON.stringify(rootsByProviderExisting.claude)} claude.missing=${JSON.stringify(rootsByProviderMissing.claude)}`);
    perfLogger.log(`[roots] gemini.existing=${JSON.stringify(rootsByProviderExisting.gemini)} gemini.missing=${JSON.stringify(rootsByProviderMissing.gemini)}`);

    try {
      // 兼容旧字段：roots 仍指向 Codex sessions roots（供 settings.codexRoots 等旧逻辑复用）
      (g.__indexer as any).roots = rootsByProviderAll.codex.slice();
      (g.__indexer as any).existingRoots = rootsByProviderExisting.codex.slice();
      (g.__indexer as any).missingRoots = rootsByProviderMissing.codex.slice();
      (g.__indexer as any).rootsByProvider = rootsByProviderAll;
      (g.__indexer as any).existingRootsByProvider = rootsByProviderExisting;
      (g.__indexer as any).missingRootsByProvider = rootsByProviderMissing;
    } catch {}

    // 3) 枚举所有会话文件并比对签名，增量更新（按 Provider 聚合）
    type ProviderFile = { providerId: ProviderId; filePath: string };
    const files: ProviderFile[] = [];
    const scanLimit = pLimit(8);

    const addFiles = (providerId: ProviderId, list: string[]) => {
      for (const fp of list) {
        if (!fp) continue;
        files.push({ providerId, filePath: fp });
      }
    };

    await Promise.all(rootsByProviderExisting.codex.map((root) => scanLimit(async () => {
      try {
        const years = await fsp.readdir(root, { withFileTypes: true })
          .then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name))
          .catch(() => [] as string[]);
        for (const y of years) {
          const ydir = path.join(root, y);
          const months = await fsp.readdir(ydir, { withFileTypes: true })
            .then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name))
            .catch(() => [] as string[]);
          for (const m of months) {
            const mdir = path.join(ydir, m);
            const days = await fsp.readdir(mdir, { withFileTypes: true })
              .then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name))
              .catch(() => [] as string[]);
            for (const d of days) {
              const ddir = path.join(mdir, d);
              const fsx = await fsp.readdir(ddir)
                .then((fs0) => fs0.filter((f) => f.endsWith(".jsonl")))
                .catch(() => [] as string[]);
              for (const f of fsx) files.push({ providerId: "codex", filePath: path.join(ddir, f) });
            }
          }
        }
      } catch {}
    })));

    await Promise.all(rootsByProviderExisting.claude.map((root) => scanLimit(async () => {
      try { addFiles("claude", await discoverClaudeSessionFiles(root, { includeAgentHistory: claudeCodeReadAgentHistory })); } catch {}
    })));

    await Promise.all(rootsByProviderExisting.gemini.map((root) => scanLimit(async () => {
      try { addFiles("gemini", await discoverGeminiSessionFiles(root)); } catch {}
    })));

    perfLogger.log(`[files] codex=${files.filter((f) => f.providerId === "codex").length} claude=${files.filter((f) => f.providerId === "claude").length} gemini=${files.filter((f) => f.providerId === "gemini").length} total=${files.length}`);

    const ix: PersistIndex = g.__indexer.index;
    const det: PersistDetails = g.__indexer.details;
    const win = getWindow();

    const rootEntriesExisting: Array<{ providerId: ProviderId; root: string }> = [
      ...rootsByProviderExisting.codex.map((root) => ({ providerId: "codex" as ProviderId, root })),
      ...rootsByProviderExisting.claude.map((root) => ({ providerId: "claude" as ProviderId, root })),
      ...rootsByProviderExisting.gemini.map((root) => ({ providerId: "gemini" as ProviderId, root })),
    ];

    const normPath = (p: string): string => {
      return String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
    };

    /**
     * 根据 filePath 归属到 Provider（优先按 root 前缀最长匹配；再用特征子串兜底）。
     */
    const resolveProviderIdForFile = (filePath: string): ProviderId => {
      try {
        const f = normPath(filePath);
        let best: { providerId: ProviderId; len: number } | null = null;
        for (const entry of rootEntriesExisting) {
          const r = normPath(entry.root);
          if (!r) continue;
          if (f === r || f.startsWith(r + "/")) {
            if (!best || r.length > best.len) best = { providerId: entry.providerId, len: r.length };
          }
        }
        if (best) return best.providerId;
        if (f.includes("/.claude/")) return "claude";
        if (f.includes("/.gemini/")) return "gemini";
        if (f.includes("/.codex/")) return "codex";
      } catch {}
      return "codex";
    };

    /**
     * 判断是否为 Provider 支持的会话文件。
     */
    const shouldIndexFile = (providerId: ProviderId, filePath: string): boolean => {
      try {
        const base = path.basename(String(filePath || "")).toLowerCase();
        if (providerId === "codex") return base.endsWith(".jsonl");
        if (providerId === "claude") {
          if (!claudeCodeReadAgentHistory && base.startsWith("agent-") && base.endsWith(".jsonl")) return false;
          return base.endsWith(".jsonl") || base.endsWith(".ndjson");
        }
        if (providerId === "gemini") return base.endsWith(".json") && base.startsWith("session-");
        return false;
      } catch {
        return false;
      }
    };

    /**
     * Gemini 的项目目录名为 projectHash；这里通过“已知项目路径”反推 hash -> cwd 映射。
     * - 来源：CodexFlow 的 `projects.json`（用户打开/扫描过的项目）
     * - 策略：对同一路径计算多种 hash 变体，覆盖 Windows/WSL 的分隔符差异
     */
    const geminiHashToCwd = new Map<string, string>();
    try {
      const projectsPath = path.join(getUserDataDir(), "projects.json");
      if (fs.existsSync(projectsPath)) {
        const raw = JSON.parse(fs.readFileSync(projectsPath, "utf8")) as any;
        const items: any[] = Array.isArray(raw) ? raw : [];
        /**
         * 将项目路径注册进 `hash -> cwd` 映射（用于 Gemini 会话缺失 cwd 时的归属与继续对话）。
         */
        const register = (p?: unknown, kind?: "win" | "wsl") => {
          try {
            if (typeof p !== "string") return;
            const t = tidyPathCandidate(p);
            if (!t) return;
            // 直接用路径字符串推导 hash（兼容盘符大小写与 /、\\ 分隔符差异）
            for (const h of deriveGeminiProjectHashCandidatesFromPath(t)) {
              if (h && !geminiHashToCwd.has(h)) geminiHashToCwd.set(h, t);
            }
            // 额外：当仅有 WSL 的 /mnt/<drive> 路径时，派生 Windows 盘符路径以覆盖 Windows 侧 Gemini hash
            if (kind === "wsl") {
              const m = t.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
              if (m) {
                const win = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
                for (const h of deriveGeminiProjectHashCandidatesFromPath(win)) {
                  if (h && !geminiHashToCwd.has(h)) geminiHashToCwd.set(h, win);
                }
              }
            }
          } catch {}
        };
        for (const it of items) {
          register(it?.wslPath, "wsl");
          register(it?.winPath, "win");
        }
      }
    } catch {}

    /**
     * 统一入口：按 Provider 解析详情（索引阶段可启用 summaryOnly）。
     */
    const parseDetailsByProvider = async (providerId: ProviderId, fp: string, stat: fs.Stats, opts?: { summaryOnly?: boolean }): Promise<Details> => {
      if (providerId === "claude") {
        const summaryOnly = !!opts?.summaryOnly;
        const maxLines = summaryOnly ? (claudeCodeReadAgentHistory ? 400 : 200) : 50_000;
        return await parseClaudeSessionFile(fp, stat, { ...(opts as any), maxLines } as any);
      }
      if (providerId === "gemini") {
        const parsed = await parseGeminiSessionFile(fp, stat, opts as any);
        try {
          const hash = String((parsed as any)?.projectHash || "").toLowerCase();
          const hasCwd = !!(parsed && (parsed as any).cwd && String((parsed as any).cwd).trim());
          if (hash && !hasCwd) {
            const mapped = geminiHashToCwd.get(hash);
            if (mapped) {
              const dirKey = dirKeyFromCwd(mapped);
              return { ...(parsed as any), cwd: mapped, dirKey } as any;
            }
          }
        } catch {}
        return parsed as any;
      }
      return await parseCodexDetails(fp, stat, opts);
    };

    // 去重：同一路径仅保留一份（按 canonicalKey）
    const uniqFiles = (() => {
      const mp = new Map<string, ProviderFile>();
      for (const f of files) {
        try {
          const k = canonicalKey(f.filePath);
          if (!k) continue;
          if (!mp.has(k)) mp.set(k, f);
        } catch {}
      }
      return Array.from(mp.values());
    })();

    const workLimit = pLimit(8);
    let updatedSummaries = 0;
    let updatedDetails = 0;
    const batch: IndexSummary[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      const items = batch.splice(0, batch.length);
      safeWindowSend(win, "history:index:add", { items }, { tag: "indexer", suppressMs: 1000 });
    };

    // 若 details 未能解析出 cwd（仅得到文件所在目录），延迟重试几次，以适配 CLI 先写头再补充 <cwd> 的行为
    async function scheduleReparse(fp: string, whenMs: number, reason: string) {
      try {
        const key = canonicalKey(fp);
        const retries: Map<string, { count: number; timer?: NodeJS.Timeout }> = g.__indexer.retries;
        const st = retries.get(key) || { count: 0 };
        if (st.count >= 3) return; // 最多重试 3 次
        st.count += 1;
        try { if (st.timer) clearTimeout(st.timer); } catch {}
        st.timer = setTimeout(async () => {
          try {
            const stat = await fsp.stat(fp).catch(() => null as any);
            if (!stat) { retries.delete(key); return; }
            const k = canonicalKey(fp);
            const sig: FileSig = { mtimeMs: stat.mtimeMs, size: stat.size };
            const providerId = resolveProviderIdForFile(fp);
            if (!shouldIndexFile(providerId, fp)) { retries.delete(key); return; }
            const details = await parseDetailsByProvider(providerId, fp, stat, { summaryOnly: true });
            if (providerId === "claude" && shouldIgnoreClaudeSession(details as any, claudeCodeReadAgentHistory)) {
              const existed = !!ix.files[k] || !!det.files[k];
              try { getDetailsCache().delete(k); } catch {}
              if (ix.files[k]) delete ix.files[k];
              if (det.files[k]) delete det.files[k];
              ix.savedAt = Date.now(); det.savedAt = Date.now();
              saveIndex(ix); saveDetails(det);
              if (existed) {
                safeWindowSend(win, "history:index:remove", { filePath: fp }, { tag: "indexer", suppressMs: 1000 });
              }
              retries.delete(key);
              return;
            }
            const fallbackDir = dirKeyOf(fp);
            const hasCwd = !!(details.cwd && String(details.cwd).trim());
            const gotProjectDir = hasCwd && (details.dirKey && details.dirKey !== fallbackDir);
            const slimDetails = stripDetailsForPersist(details);
            const summary: IndexSummary = {
              providerId,
              id: details.id,
              title: details.title,
              date: details.date,
              filePath: fp,
              rawDate: details.rawDate,
              dirKey: details.dirKey || dirKeyOf(fp),
              preview: details.preview,
              resumeMode: details.resumeMode,
              resumeId: details.resumeId,
              runtimeShell: details.runtimeShell && details.runtimeShell !== 'unknown' ? details.runtimeShell : detectRuntimeShell(fp),
            } as any;
            try { getDetailsCache().delete(k); } catch {}
            det.files[k] = { sig, details: slimDetails };
            ix.files[k] = { sig, summary };
            ix.savedAt = Date.now(); det.savedAt = Date.now();
            saveIndex(ix); saveDetails(det);
            if (gotProjectDir) {
              safeWindowSend(win, "history:index:update", { item: summary }, { tag: "indexer", suppressMs: 1000 });
              retries.delete(key);
            } else {
              // 若仍未提取到 cwd，继续按指数回退重试
              const nextDelay = st.count === 1 ? 2500 : (st.count === 2 ? 6000 : 12000);
              idxLog(`[retry] reparse scheduled count=${st.count} next=${nextDelay}ms reason=${reason} file='${fp}'`);
              await scheduleReparse(fp, nextDelay, 'retry');
            }
          } catch {
            retries.delete(canonicalKey(fp));
          }
        }, Math.max(500, whenMs));
        retries.set(key, st);
        idxLog(`[retry] scheduled in ${whenMs}ms reason=${reason} file='${fp}'`);
      } catch {}
    }

    await Promise.all(uniqFiles.map(({ providerId, filePath: fp }) => workLimit(async () => {
      try {
        if (!shouldIndexFile(providerId, fp)) return;
        const stat = await fsp.stat(fp).catch(() => null as any);
        if (!stat) return;
        const k = canonicalKey(fp);
        const sig: FileSig = { mtimeMs: stat.mtimeMs, size: stat.size };
        const prev = ix.files[k]?.sig;
        const same = prev && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size;
        if (!same) {
          const details = await parseDetailsByProvider(providerId, fp, stat, { summaryOnly: true });
          if (providerId === "claude" && shouldIgnoreClaudeSession(details as any, claudeCodeReadAgentHistory)) {
            try { getDetailsCache().delete(k); } catch {}
            if (ix.files[k]) delete ix.files[k];
            if (det.files[k]) delete det.files[k];
            return;
          }
          const slimDetails = stripDetailsForPersist(details);
          try { getDetailsCache().delete(k); } catch {}
          det.files[k] = { sig, details: slimDetails };
          updatedDetails++;
          const summary: IndexSummary = {
            providerId,
            id: details.id,
            title: details.title,
            date: details.date,
            filePath: fp,
            rawDate: details.rawDate,
            dirKey: details.dirKey || dirKeyOf(fp),
            preview: details.preview,
            resumeMode: details.resumeMode,
            resumeId: details.resumeId,
            runtimeShell: details.runtimeShell && details.runtimeShell !== 'unknown' ? details.runtimeShell : detectRuntimeShell(fp),
          } as any;
          ix.files[k] = { sig, summary };
          updatedSummaries++;
          batch.push(summary);
          // 若暂未提取到 cwd（dirKey 仍为文件所在目录），延迟重试解析
          try {
            const fallbackDir = dirKeyOf(fp);
            const hasCwd = !!(details.cwd && String(details.cwd).trim());
            if (!hasCwd || (summary.dirKey === fallbackDir)) {
              await scheduleReparse(fp, 2000, hasCwd ? 'dirKey=fallback' : 'no-cwd');
            }
          } catch {}
          if (batch.length >= 50) flush();
        }
      } catch {}
    })));
    flush();
    ix.savedAt = Date.now(); det.savedAt = Date.now();
    saveIndex(ix); saveDetails(det);
    perfLogger.log(`[indexer] updated summaries=${updatedSummaries} details=${updatedDetails}`);

    // 4) 文件变化监听（可选）
    if (chokidar && rootEntriesExisting.length > 0) {
      // 每次启动索引器先清空 watch 队列（防止上一轮残留 timer 触发）
      try { clearWatchQueueState(); } catch {}

      const watchLimit = pLimit(WATCH_CONCURRENCY);

      /**
       * 执行一次“文件变更 -> 索引 upsert”的核心逻辑（不做去抖/合并）。
       */
      async function upsertFromWatch(fp: string): Promise<void> {
        try {
          const providerId = resolveProviderIdForFile(fp);
          if (!shouldIndexFile(providerId, fp)) return;
          const stat = await fsp.stat(fp).catch(() => null as any);
          if (!stat) return;
          const k = canonicalKey(fp);
          const sig: FileSig = { mtimeMs: stat.mtimeMs, size: stat.size };
          // 先解析 details 并直接构造 summary，零额外 IO
          const details = await parseDetailsByProvider(providerId, fp, stat, { summaryOnly: true });
          if (providerId === "claude" && shouldIgnoreClaudeSession(details as any, claudeCodeReadAgentHistory)) {
            const existed = !!ix.files[k] || !!det.files[k];
            try { getDetailsCache().delete(k); } catch {}
            if (ix.files[k]) delete ix.files[k];
            if (det.files[k]) delete det.files[k];
            ix.savedAt = Date.now(); det.savedAt = Date.now(); saveIndex(ix); saveDetails(det);
            if (existed) safeWindowSend(win, "history:index:remove", { filePath: fp }, { tag: "indexer", suppressMs: 1000 });
            return;
          }
          const slimDetails = stripDetailsForPersist(details);
          try { getDetailsCache().delete(k); } catch {}
          det.files[k] = { sig, details: slimDetails };
          const summary: IndexSummary = {
            providerId,
            id: details.id,
            title: details.title,
            date: details.date,
            filePath: fp,
            rawDate: details.rawDate,
            dirKey: details.dirKey || dirKeyOf(fp),
            preview: details.preview,
            resumeMode: details.resumeMode,
            resumeId: details.resumeId,
            runtimeShell: details.runtimeShell && details.runtimeShell !== 'unknown' ? details.runtimeShell : detectRuntimeShell(fp),
          } as any;
          ix.files[k] = { sig, summary };
          ix.savedAt = Date.now(); det.savedAt = Date.now(); saveIndex(ix); saveDetails(det);
          safeWindowSend(win, "history:index:update", { item: summary }, { tag: "indexer", suppressMs: 1000 });
          try {
            const fallbackDir = dirKeyOf(fp);
            const hasCwd = !!(details.cwd && String(details.cwd).trim());
            if (!hasCwd || (summary.dirKey === fallbackDir)) {
              await scheduleReparse(fp, 2000, hasCwd ? 'dirKey=fallback(change)' : 'no-cwd(change)');
            }
          } catch {}
        } catch {}
      }

      /**
       * flush watch 队列：对同一文件的短时间频繁变更进行合并（去抖 + 批处理 + 限并发）。
       */
      async function flushWatchQueue(): Promise<void> {
        const st = getWatchQueueState();
        if (st.flushing) return;
        st.flushing = true;
        try {
          while (true) {
            const now = Date.now();
            const due: string[] = [];
            for (const [k, v] of Array.from(st.queue.entries())) {
              if (v.dueAt > now) continue;
              st.queue.delete(k);
              due.push(v.filePath);
            }
            if (due.length === 0) break;
            for (let i = 0; i < due.length; i += WATCH_BATCH_LIMIT) {
              const batch = due.slice(i, i + WATCH_BATCH_LIMIT);
              await Promise.all(batch.map((p) => watchLimit(() => upsertFromWatch(p))));
              // 让出事件循环，避免主进程长时间被占用导致 UI 卡顿
              await new Promise<void>((r) => setImmediate(r));
            }
          }
        } catch {
          // ignore
        } finally {
          st.flushing = false;
          if (st.queue.size > 0) scheduleWatchFlush();
        }
      }

      /**
       * 安排一次 watch flush（始终最多挂一个 timer）。
       */
      function scheduleWatchFlush(): void {
        const st = getWatchQueueState();
        if (st.timer) return;
        st.timer = setTimeout(() => {
          try { const st2 = getWatchQueueState(); st2.timer = null; } catch {}
          flushWatchQueue().catch(() => {});
        }, WATCH_DEBOUNCE_MS);
      }

      /**
       * 监听事件入队：对同一文件路径做去抖合并，避免频繁 change/add 触发重复解析。
       */
      function enqueueWatchChange(fp: string): void {
        try {
          const k = canonicalKey(fp);
          const st = getWatchQueueState();
          st.queue.set(k, { filePath: fp, dueAt: Date.now() + WATCH_DEBOUNCE_MS });
          scheduleWatchFlush();
        } catch {}
      }

      const onUnlink = (fp: string) => {
        try {
          try { getWatchQueueState().queue.delete(canonicalKey(fp)); } catch {}
          const k = canonicalKey(fp);
          const removed = ix.files[k]?.summary;
          try { getDetailsCache().delete(k); } catch {}
          delete ix.files[k]; delete det.files[k];
          ix.savedAt = Date.now(); det.savedAt = Date.now(); saveIndex(ix); saveDetails(det);
          if (removed) safeWindowSend(win, "history:index:remove", { filePath: fp }, { tag: "indexer", suppressMs: 1000 });
        } catch {}
      };

        const isUNC = (p: string) => {
          try {
            const raw = String(p || '');
            if (/^\\\\wsl\.localhost\\/i.test(raw)) return true;
            if (/^\/\/wsl\.localhost\//i.test(raw)) return true;
            const s = raw.replace(/\//g, '\\');
            return /^\\\\wsl\.localhost\\/i.test(s);
          } catch { return false; }
        };
        const patternsForProvider = (providerId: ProviderId): string[] => {
          if (providerId === "codex") return ["*.jsonl"];
          if (providerId === "claude") return ["*.jsonl", "*.ndjson"];
          if (providerId === "gemini") return ["session-*.json"];
          return ["*.jsonl"];
        };

        /**
         * 计算 Provider 的监听根目录，减少无关扫描：
         * - Claude：优先监听 `<root>/projects`（与 discovery 行为一致，避免拾取 root 下无关 JSONL）。
         */
        const resolveWatchRootForProvider = async (providerId: ProviderId, root: string): Promise<string> => {
          if (providerId !== "claude") return root;
          try {
            const projectsRoot = path.join(root, "projects");
            const st = await fsp.stat(projectsRoot).catch(() => null as any);
            if (st && st.isDirectory()) return projectsRoot;
          } catch {}
          return root;
        };

        const watchEntriesExisting = (await Promise.all(rootEntriesExisting.map(async (e) => {
          const r = await resolveWatchRootForProvider(e.providerId, e.root);
          return { providerId: e.providerId, root: r };
        }))).filter((e) => !!e.root);

        const localEntries = watchEntriesExisting.filter((e) => !isUNC(e.root));
        const uncEntries = watchEntriesExisting.filter((e) => isUNC(e.root));

        const makeGlobs = (entries: Array<{ providerId: ProviderId; root: string }>) => {
          const out: string[] = [];
          for (const entry of entries) {
            const r = entry.root;
            const pats = patternsForProvider(entry.providerId);
            for (const pat of pats) {
              try {
                // 同时提供反斜杠样式与 POSIX 样式的 glob，提升 UNC/Windows 兼容性
                const back = path.join(r, "**", pat);
                out.push(back);
                const posix = r.replace(/\\/g, "/").replace(/\/+$/g, "") + `/**/${pat}`;
                out.push(posix);
              } catch {
                try { out.push(path.join(r, "**", pat)); } catch {}
              }
            }
          }
          return out;
        };

        const watchers: any[] = [];
        try {
          if (localEntries.length > 0) {
            const globsLocal = makeGlobs(localEntries);
            idxLog(`[watch:init local] globs=${JSON.stringify(globsLocal)}`);
            const w1 = chokidar.watch(globsLocal, {
              ignoreInitial: true,
              awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
              depth: 10,
              followSymlinks: false,
              ignored: ['**/node_modules/**', '**/.git/**'],
            });
            w1.on('add', enqueueWatchChange).on('change', enqueueWatchChange).on('unlink', onUnlink).on('error', (e: any) => { perfLogger.log(`[watch:error local] ${String(e)}`); });
            // ready 时记录
            try { w1.on('ready', () => { idxLog(`[watch:ready local] paths=${JSON.stringify(localEntries.map((x) => x.root))}`); }); } catch {}
            watchers.push(w1);
          }
        } catch (e) { perfLogger.log(`[watch:init local failed] ${String(e)}`); }
        try {
          if (uncEntries.length > 0) {
            // UNC 到 WSL 的共享不可靠，使用轮询模式
            const globsUNC = makeGlobs(uncEntries);
            idxLog(`[watch:init unc] globs=${JSON.stringify(globsUNC)}`);
            const w2 = chokidar.watch(globsUNC, {
              ignoreInitial: true,
              awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
              depth: 10,
              usePolling: true,
              interval: 2500,
              binaryInterval: 4000,
              followSymlinks: false,
              ignored: ['**/node_modules/**', '**/.git/**'],
            });
            w2.on('add', enqueueWatchChange).on('change', enqueueWatchChange).on('unlink', onUnlink).on('error', (e: any) => { perfLogger.log(`[watch:error unc] ${String(e)}`); });
            try { w2.on('ready', () => { idxLog(`[watch:ready unc] paths=${JSON.stringify(uncEntries.map((x) => x.root))}`); }); } catch {}
            watchers.push(w2);
          }
        } catch (e) { perfLogger.log(`[watch:init unc failed] ${String(e)}`); }
        g.__indexer.watchers = watchers;
        perfLogger.log(`[watch] enabled using chokidar (local=${localEntries.length}, unc=${uncEntries.length})`);
        // 5) 周期性轻量重扫：仅扫描当天与前一天目录，弥补 UNC 监听遗漏的新增/变更
        const rescanRoots = uncEntries
          .filter((e) => e.providerId === "codex")
          .map((e) => e.root);
        if (rescanRoots.length > 0) try {
          const upsertQuick = async (fp: string) => {
            try {
              idxLog(`[rescan] checking file='${fp}'`);
              const stat = await fsp.stat(fp).catch(() => null as any);
              if (!stat) return;
              const k = canonicalKey(fp);
              const sig: FileSig = { mtimeMs: stat.mtimeMs, size: stat.size };
              const prev = ix.files[k]?.sig;
              const same = prev && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size;
              if (same) return;
              const now = Date.now();
              if (shouldThrottleRescan(k, now)) {
                idxLog(`[rescan] skip.cooldown file='${fp}'`);
                return;
              }
              markRescanCooldown(k, now);
              const details = await parseDetailsByProvider("codex", fp, stat, { summaryOnly: true });
              const slimDetails = stripDetailsForPersist(details);
              try { getDetailsCache().delete(k); } catch {}
              det.files[k] = { sig, details: slimDetails };
              const summary: IndexSummary = {
                providerId: "codex",
                id: details.id,
                title: details.title,
                date: details.date,
                filePath: fp,
                rawDate: details.rawDate,
                dirKey: details.dirKey || dirKeyOf(fp),
                preview: details.preview,
                resumeMode: details.resumeMode,
                resumeId: details.resumeId,
                runtimeShell: details.runtimeShell && details.runtimeShell !== 'unknown' ? details.runtimeShell : detectRuntimeShell(fp),
              } as any;
              ix.files[k] = { sig, summary };
              ix.savedAt = Date.now(); det.savedAt = Date.now();
              saveIndex(ix); saveDetails(det);
              safeWindowSend(win, "history:index:update", { item: summary }, { tag: "indexer", suppressMs: 1000 });
              idxLog(`[rescan] updated index for file='${fp}' dirKey='${summary.dirKey}'`);
              // If dirKey still falls back, schedule reparse
              try {
                const fallbackDir = dirKeyOf(fp);
                const hasCwd = !!(details.cwd && String(details.cwd).trim());
                if (!hasCwd || (summary.dirKey === fallbackDir)) {
                  await scheduleReparse(fp, 2500, hasCwd ? 'dirKey=fallback(rescan)' : 'no-cwd(rescan)');
                }
              } catch {}
            } catch (e) { idxLog(`[rescan:error] file='${fp}' err=${String(e)}`); }
          };
          const listDayDir = async (root: string, d: Date) => {
            try {
              const y = String(d.getFullYear());
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              const dir = path.join(root, y, m, day);
              const fsx = await fsp.readdir(dir).then((fs0) => fs0.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
              return fsx.map((f) => path.join(dir, f));
            } catch { return [] as string[]; }
          };
          try {
            const prevTimer: NodeJS.Timeout | null | undefined = (g.__indexer as any)?.rescanTimer;
            if (prevTimer) {
              try { clearInterval(prevTimer); } catch {}
            }
          } catch {}
          const timer = setInterval(async () => {
            try {
              const today = new Date();
              const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
              const limit2 = pLimit(6);
              for (const r of rescanRoots) {
                const filesToday = await listDayDir(r, today);
                const filesYest = await listDayDir(r, yesterday);
                const files = Array.from(new Set([...filesToday, ...filesYest]));
                await Promise.all(files.map((fp) => limit2(() => upsertQuick(fp))));
              }
            } catch (e) { idxLog(`[rescan:error] err=${String(e)}`); }
          }, RESCAN_INTERVAL_MS);
          try { (g.__indexer as any).rescanTimer = timer; } catch {}
        } catch (e) { idxLog(`[rescan:init failed] ${String(e)}`); }
        else { idxLog("[rescan] skipped (no UNC roots)"); }
      } else { perfLogger.log(`[watch] disabled (no chokidar)`); }
  });
}

export function getLastIndexerRoots(): string[] {
  try { const roots: string[] = (g.__indexer && g.__indexer.roots) ? g.__indexer.roots : []; return Array.isArray(roots) ? roots : []; } catch { return []; }
}

/**
 * 获取索引器最近一次探测到的指定 Provider 根目录（优先返回“存在的 roots”）。
 */
export function getLastIndexerRootsByProvider(providerId: string): string[] {
  try {
    const id = String(providerId || "codex").trim().toLowerCase();
    const map = (g.__indexer && (g.__indexer.existingRootsByProvider || g.__indexer.rootsByProvider)) ? (g.__indexer.existingRootsByProvider || g.__indexer.rootsByProvider) : {};
    const roots = map && Object.prototype.hasOwnProperty.call(map, id) ? (map as any)[id] : [];
    return Array.isArray(roots) ? roots : [];
  } catch {
    return [];
  }
}

// 供主进程在删除文件后主动清理索引与详情缓存，避免切换项目时已删除项回流
export function removeFromIndex(filePath: string): boolean {
  try {
    const ix: PersistIndex = g.__indexer.index || { version: VERSION, files: {}, savedAt: 0 };
    const det: PersistDetails = g.__indexer.details || { version: VERSION, files: {}, savedAt: 0 };
    const k = canonicalKey(filePath);
    const existed = !!ix.files[k] || !!det.files[k];
    try { getDetailsCache().delete(k); } catch {}
    if (ix.files[k]) delete ix.files[k];
    if (det.files[k]) delete det.files[k];
    if (existed) {
      ix.savedAt = Date.now();
      det.savedAt = Date.now();
      saveIndex(ix);
      saveDetails(det);
    }
    return existed;
  } catch { return false; }
}

export async function stopHistoryIndexer(): Promise<void> {
  try {
    const watchers = Array.isArray(g.__indexer?.watchers) ? (g.__indexer.watchers as any[]) : [];
    if (watchers.length > 0) {
      const tasks = watchers.map(async (w) => {
        try {
          if (!w) return;
          if (typeof w.close === 'function') {
            await Promise.resolve(w.close());
            return;
          }
          if (typeof w.stop === 'function') {
            await Promise.resolve(w.stop());
          }
        } catch {}
      });
      try { await Promise.allSettled(tasks); } catch {}
    }
  } catch {}
  try { (g.__indexer as any).watchers = []; } catch {}
  try {
    const timer = (g.__indexer as any)?.rescanTimer;
    if (timer) {
      try { clearInterval(timer); } catch {}
    }
    (g.__indexer as any).rescanTimer = null;
  } catch {}
  try {
    const retries: Map<string, { count: number; timer?: NodeJS.Timeout }> | undefined = g.__indexer?.retries;
    if (retries && typeof retries.forEach === 'function') {
      retries.forEach((st) => {
        try { if (st?.timer) clearTimeout(st.timer); } catch {}
      });
      retries.clear();
    }
  } catch {}
  try { clearRescanCooldown(); } catch {}
  try { clearWatchQueueState(); } catch {}
}
