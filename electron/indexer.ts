// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow } from "electron";
import { perfLogger } from "./log";
import { getDebugConfig } from "./debugConfig";
import { getSessionsRootCandidatesFastAsync, isUNCPath, uncToWsl, wslToUNC, type SessionsRootCandidate } from "./wsl";
import { safeWindowSend } from "./ipcSafe";
import { detectResumeInfo, detectRuntimeShell, detectRuntimeShellFromContent } from "./history";
import type { HistorySummary, Message, MessageContent, RuntimeShell } from "./history";
import settings from "./settings";
import { loadCodexStateSnapshot } from "./codexStateSnapshot";
import { getClaudeRootCandidatesFastAsync } from "./agentSessions/claude/discovery";
import { getGeminiRootCandidatesFastAsync } from "./agentSessions/gemini/discovery";
import { getAntigravityRootCandidatesFastAsync } from "./agentSessions/antigravity/discovery";
import { getGrokRootCandidatesFastAsync, getGrokSessionVisibility } from "./agentSessions/grok/discovery";
import { parseClaudeSessionFile } from "./agentSessions/claude/parser";
import { parseGeminiSessionFile, deriveGeminiProjectHashCandidatesFromPath } from "./agentSessions/gemini/parser";
import { parseAntigravitySessionFile } from "./agentSessions/antigravity/parser";
import { parseGrokSessionFile } from "./agentSessions/grok/parser";
import { filterCodexHistoryPreviewText } from "./agentSessions/shared/preview";
import { openCodexHistoryStream, selectCurrentHistorySummaries } from "./codexRollout";
import {
  extractCodexSessionRelationship,
  type CodexSessionRecord,
  type CodexSessionRelationship,
} from "./codexSessionRelations";
import { extractTaggedPrefix } from "./agentSessions/shared/taggedPrefix";
import {
  dirKeyFromCwd as dirKeyFromCwdShared,
  dirKeyOfFilePath as dirKeyOfFilePathShared,
  tidyPathCandidate as tidyPathCandidateShared,
} from "./agentSessions/shared/path";

export type ProviderId = "codex" | "claude" | "gemini" | "antigravity" | "grok";
export type FileSig = {
  mtimeMs: number;
  size: number;
  auxMtimeMs?: number;
  auxSize?: number;
};
type IndexSummary = HistorySummary & { providerId: ProviderId; dirKey: string; projectHash?: string; codexHistoryResolved?: boolean };
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
  projectHash?: string;
  resumeMode?: 'modern' | 'legacy' | 'unknown';
  resumeId?: string;
  runtimeShell?: RuntimeShell;
  codexRelationship?: CodexSessionRelationship;
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

type DirKeyResolutionState = {
  normalizedCwd: string;
  resolvedDirKey: string;
  fallbackDirKey: string;
  hasCwd: boolean;
  usesFallbackDir: boolean;
};

// 单次偏好的详情缓存大小：保留最近查看的几条，防止无限增长
const DETAILS_CACHE_LIMIT = 8;
// 历史首条输入预览的索引长度上限：用于搜索匹配（展示仍由前端自行截断）
const HISTORY_PREVIEW_SEARCH_MAX_CHARS = 240;

/**
 * 从 Codex 事件中提取 App Server 生成的线程名。
 */
function extractCodexThreadNameFromRecord(obj: any): string {
  try {
    if (!obj || typeof obj !== "object") return "";
    if (obj.type !== "event_msg") return "";
    const payload = obj.payload;
    if (!payload || payload.type !== "thread_name_updated") return "";
    return String(payload.thread_name || "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

const g: any = global as any;
if (!g.__indexer) g.__indexer = {};
const PERSIST_DEBOUNCE_MS = 2_000;
const PERSIST_MAX_WAIT_MS = 15_000;

type PersistWriteState = {
  timer: NodeJS.Timeout | null;
  running: boolean;
  pendingIndex: boolean;
  pendingDetails: boolean;
  firstPendingAt: number;
  lastPendingAt: number;
  index?: PersistIndex;
  details?: PersistDetails;
  waiters: Array<() => void>;
};
type IndexedSummaryCache = {
  index: PersistIndex;
  summaries: IndexSummary[];
};
type HistoryFastRefreshRequest = {
  providerId?: ProviderId | string;
  filePath?: string;
  sourcePath?: string;
  transcriptPath?: string;
  sessionId?: string;
  threadId?: string;
  cwd?: string;
  reason?: string;
};
type HistoryReconcilerRuntimePort = {
  hasPendingCodexWork(): boolean;
  requestFastRefresh(request: HistoryFastRefreshRequest): void;
};
type CodexRelationIndexState = {
  ready: boolean;
};

let historyReconcilerRuntimePort: HistoryReconcilerRuntimePort | null = null;
let historyIndexerLifecycleGeneration = 0;
let historyIndexerLifecycleQueue: Promise<void> = Promise.resolve();

/**
 * 注册历史协调器的同步窄端口，避免索引器与协调器形成静态循环依赖。
 */
export function registerHistoryReconcilerRuntimePort(port: HistoryReconcilerRuntimePort | null): void {
  historyReconcilerRuntimePort = port;
}

/**
 * 获取 Codex 关系索引的同步状态。
 */
function getCodexRelationIndexState(): CodexRelationIndexState {
  if (!g.__indexer) g.__indexer = {};
  if (!g.__indexer.codexRelationIndexState) {
    g.__indexer.codexRelationIndexState = {
      ready: false,
    } as CodexRelationIndexState;
  }
  return g.__indexer.codexRelationIndexState as CodexRelationIndexState;
}

/**
 * 重置 Codex 关系索引状态；索引器完成首轮扫描前禁止整树删除。
 */
function resetCodexRelationIndexState(): void {
  if (!g.__indexer) g.__indexer = {};
  g.__indexer.codexRelationIndexState = {
    ready: false,
  } as CodexRelationIndexState;
}

/**
 * 设置 Codex 关系索引首轮扫描是否完成。
 */
function setCodexRelationIndexReady(ready: boolean): void {
  getCodexRelationIndexState().ready = ready === true;
}

/**
 * 判断整树删除能否直接使用内存关系快照，不执行确认阶段的全量扫描。
 */
export function isCodexRelationIndexReady(): boolean {
  const state = getCodexRelationIndexState();
  if (!state.ready) return false;
  try { if (historyReconcilerRuntimePort?.hasPendingCodexWork()) return false; } catch {}
  return true;
}

/**
 * 获取索引缓存持久化队列状态。
 */
function getPersistWriteState(): PersistWriteState {
  if (!g.__indexer) g.__indexer = {};
  if (!g.__indexer.persistWriteState) {
    g.__indexer.persistWriteState = {
      timer: null,
      running: false,
      pendingIndex: false,
      pendingDetails: false,
      firstPendingAt: 0,
      lastPendingAt: 0,
      waiters: [],
    } as PersistWriteState;
  }
  const state = g.__indexer.persistWriteState as PersistWriteState;
  if (!Number.isFinite(state.firstPendingAt)) state.firstPendingAt = 0;
  if (!Number.isFinite(state.lastPendingAt)) state.lastPendingAt = 0;
  return state;
}

/**
 * 将索引缓存写入任务合并到下一轮事件循环，避免同一批变更重复序列化大文件。
 */
function schedulePersistWrite(index?: PersistIndex, details?: PersistDetails): void {
  const state = getPersistWriteState();
  const alreadyPending = state.pendingIndex || state.pendingDetails;
  const now = Date.now();
  if (!alreadyPending) state.firstPendingAt = now;
  state.lastPendingAt = now;
  if (index) {
    state.pendingIndex = true;
    state.index = index;
  }
  if (details) {
    state.pendingDetails = true;
    state.details = details;
  }
  schedulePersistFlush();
}

/**
 * 中文说明：使历史摘要派生缓存失效，确保索引变更后下次读取重新生成。
 */
function invalidateIndexedSummaryCache(): void {
  try { delete g.__indexer.indexedSummaryCache; } catch {}
}

/** 安排一次缓存持久化队列处理，兼顾空闲去抖与持续写入的最大等待时间。 */
function schedulePersistFlush(): void {
  const state = getPersistWriteState();
  if (state.running || (!state.pendingIndex && !state.pendingDetails)) return;
  const now = Date.now();
  const firstPendingAt = state.firstPendingAt > 0 ? state.firstPendingAt : now;
  const lastPendingAt = state.lastPendingAt > 0 ? state.lastPendingAt : now;
  const deadline = Math.min(lastPendingAt + PERSIST_DEBOUNCE_MS, firstPendingAt + PERSIST_MAX_WAIT_MS);
  if (state.timer) {
    try { clearTimeout(state.timer); } catch {}
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushPersistWrites();
  }, Math.max(0, deadline - now));
}

/** 让出一次事件循环，避免缓存序列化连续占用主线程。 */
function yieldPersistSerialization(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** 分段序列化索引缓存，避免对整个大对象执行一次长时间 JSON.stringify。 */
async function serializeIndexForPersist(index: PersistIndex): Promise<string> {
  const parts: string[] = [
    "{\"version\":",
    JSON.stringify(String(index.version || VERSION)),
    ",\"files\":{"
  ];
  const entries = Object.entries(index.files || {});
  let first = true;
  for (let i = 0; i < entries.length; i += 1) {
    const [key, value] = entries[i];
    let serialized = "null";
    try { serialized = JSON.stringify(value) ?? "null"; } catch {}
    if (!first) parts.push(",");
    first = false;
    parts.push(JSON.stringify(key), ":", serialized);
    if ((i + 1) % 32 === 0) await yieldPersistSerialization();
  }
  const savedAt = Number(index.savedAt);
  parts.push("},\"savedAt\":", String(Number.isFinite(savedAt) ? savedAt : 0), "}");
  return parts.join("");
}

/** 分段序列化详情缓存，并在每个条目内移除完整消息正文。 */
async function serializeDetailsForPersist(details: PersistDetails): Promise<string> {
  const parts: string[] = [
    "{\"version\":",
    JSON.stringify(VERSION),
    ",\"files\":{"
  ];
  const entries = Object.entries(details.files || {});
  let first = true;
  for (let i = 0; i < entries.length; i += 1) {
    const [key, entry] = entries[i];
    if (!entry || !entry.details || !entry.sig) continue;
    const normalizedEntry = { sig: entry.sig, details: stripDetailsForPersist(entry.details) };
    let serialized = "null";
    try { serialized = JSON.stringify(normalizedEntry) ?? "null"; } catch {}
    if (!first) parts.push(",");
    first = false;
    parts.push(JSON.stringify(key), ":", serialized);
    if ((i + 1) % 32 === 0) await yieldPersistSerialization();
  }
  const rawSavedAt = Number(details.savedAt);
  const savedAt = Number.isFinite(rawSavedAt) && rawSavedAt > 0 ? rawSavedAt : Date.now();
  parts.push("},\"savedAt\":", String(savedAt), "}");
  return parts.join("");
}

/**
 * 串行异步写入索引和详情缓存；调用方可等待该函数确保退出前刷盘完成。
 */
async function flushPersistWrites(force = false): Promise<void> {
  const state = getPersistWriteState();
  if (state.running) {
    await new Promise<void>((resolve) => state.waiters.push(resolve));
    if (force && (state.pendingIndex || state.pendingDetails)) await flushPersistWrites(true);
    return;
  }
  if (!state.pendingIndex && !state.pendingDetails) return;
  if (state.timer) {
    try { clearTimeout(state.timer); } catch {}
    state.timer = null;
  }
  state.running = true;
  const writeIndex = state.pendingIndex;
  const writeDetails = state.pendingDetails;
  state.pendingIndex = false;
  state.pendingDetails = false;
  state.firstPendingAt = 0;
  state.lastPendingAt = 0;
  try {
    // 先让出一次事件循环，确保通知 IPC 和终端输出优先处理。
    await new Promise<void>((resolve) => setImmediate(resolve));
    const tasks: Promise<unknown>[] = [];
    if (writeIndex && state.index) {
      const currentIndex = state.index;
      tasks.push(serializeIndexForPersist(currentIndex)
        .then((body) => fsp.mkdir(path.dirname(indexPath()), { recursive: true })
          .then(() => fsp.writeFile(indexPath(), body, "utf8")))
        .catch(() => undefined));
    }
    if (writeDetails && state.details) {
      const currentDetails = state.details;
      tasks.push(serializeDetailsForPersist(currentDetails)
        .then((body) => fsp.mkdir(path.dirname(detailsPath()), { recursive: true })
          .then(() => fsp.writeFile(detailsPath(), body, "utf8")))
        .catch(() => undefined));
    }
    if (tasks.length > 0) await Promise.all(tasks);
  } finally {
    state.running = false;
    const waiters = state.waiters.splice(0, state.waiters.length);
    for (const resolve of waiters) {
      try { resolve(); } catch {}
    }
  }
  if (state.pendingIndex || state.pendingDetails) {
    if (force) await flushPersistWrites(true);
    else schedulePersistFlush();
  }
}

/**
 * 保存索引器使用的窗口 getter，供增量刷新路径复用。
 */
function setIndexerWindowGetter(getWindow: (() => BrowserWindow | null) | null): void {
  try {
    if (!g.__indexer) g.__indexer = {};
    (g.__indexer as any).windowGetter = getWindow || null;
  } catch {}
}

/**
 * 读取索引器当前绑定的主窗口。
 */
function getIndexerWindow(): BrowserWindow | null {
  try {
    const getter = (g.__indexer as any)?.windowGetter;
    if (typeof getter !== "function") return null;
    return getter();
  } catch {
    return null;
  }
}

function stripDetailsForPersist(details: Details): Details {
  const { messages, ...rest } = details as Details & { messages?: Message[] };
  return { ...rest, messages: [] };
}

// 修正 Windows 目录名中的反斜杠与 n 后提升版本，避免继续复用错误的项目归属。
const VERSION = "v19";

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
/**
 * 中文说明：删除当前索引版本以外的旧缓存文件，并返回本次清理掉的文件名。
 */
function purgeLegacyPersistFiles(): string[] {
  const removed: string[] = [];
  try {
    const dir = getUserDataDir();
    const files = fs.readdirSync(dir);
    const currentSuffix = `.${VERSION}.json`;
    for (const fileName of files) {
      if (!/^history\.(?:index|details)\.v\d+\.json$/i.test(fileName)) continue;
      if (fileName.endsWith(currentSuffix)) continue;
      try {
        fs.rmSync(path.join(dir, fileName), { force: true });
        removed.push(fileName);
      } catch {}
    }
  } catch {}
  return removed;
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

async function loadIndex(): Promise<PersistIndex> {
  try {
    const p = indexPath();
    const raw = await fsp.readFile(p, "utf8").catch(() => "");
    if (!raw) return { version: VERSION, files: {}, savedAt: 0 };
    const obj = JSON.parse(raw);
    return { version: VERSION, files: obj.files || {}, savedAt: Number(obj.savedAt || 0) } as PersistIndex;
  } catch { return { version: VERSION, files: {}, savedAt: 0 }; }
}

/**
 * 预读持久化历史索引，并让并发请求复用同一次磁盘读取。
 *
 * 该方法只加载列表摘要，不扫描会话目录；因此可在窗口创建前启动，
 * 也可由 history.list 在首次请求时短暂等待，避免错误进入重型回退扫描。
 */
export async function ensureHistoryIndexLoaded(): Promise<void> {
  if (!g.__indexer) g.__indexer = {};
  if (g.__indexer.indexLoaded === true) return;
  if (!g.__indexer.indexLoadPromise) {
    g.__indexer.indexLoadPromise = (async () => {
      g.__indexer.index = await loadIndex();
      invalidateIndexedSummaryCache();
      g.__indexer.indexLoaded = true;
    })().finally(() => {
      g.__indexer.indexLoadPromise = null;
    });
  }
  await g.__indexer.indexLoadPromise;
}

/**
 * 请求异步保存索引缓存，不在当前调用栈执行文件 I/O。
 */
function saveIndex(ix: PersistIndex): void {
  invalidateIndexedSummaryCache();
  try { schedulePersistWrite(ix, undefined); } catch {}
}

async function loadDetails(): Promise<PersistDetails> {
  try {
    const p = detailsPath();
    const raw = await fsp.readFile(p, "utf8").catch(() => "");
    if (!raw) return { version: VERSION, files: {}, savedAt: 0 };
    const obj = JSON.parse(raw) as any;
    const normalized: PersistDetails = { version: VERSION, files: {}, savedAt: Number(obj.savedAt || 0) };
    let trimmed = false;
    const files = (obj && obj.files) ? obj.files as Record<string, { sig: FileSig; details: Details }> : {};
    for (const [k, entry] of Object.entries(files)) {
      if (!entry || !entry.details || !entry.sig) continue;
      if (Array.isArray((entry.details as any).messages) && (entry.details as any).messages.length > 0)
        trimmed = true;
      const slim = stripDetailsForPersist(entry.details);
      normalized.files[k] = { sig: entry.sig, details: slim };
    }
    if (trimmed) {
      // 兼容旧版含正文的缓存：先在内存裁剪，再异步回写，避免每次启动重复读取大正文。
      try { saveDetails(normalized); } catch {}
    }
    return normalized;
  } catch { return { version: VERSION, files: {}, savedAt: 0 }; }
}

/**
 * 请求异步保存详情缓存，并在队列中统一去除消息正文。
 */
function saveDetails(d: PersistDetails): void {
  try { schedulePersistWrite(undefined, d); } catch {}
}

// 并发限制器
function canonicalKey(filePath: string): string {
  try { return path.normalize(filePath).replace(/\\/g, "/").toLowerCase(); } catch { return String(filePath || "").toLowerCase(); }
}

/**
 * 读取当前索引器已探测到的 Provider 根目录。
 */
function getExistingRootsByProvider(): Record<ProviderId, string[]> {
  try {
    const raw = (g.__indexer && (g.__indexer.existingRootsByProvider || g.__indexer.rootsByProvider)) ? (g.__indexer.existingRootsByProvider || g.__indexer.rootsByProvider) : {};
    return {
      codex: Array.isArray(raw?.codex) ? raw.codex : [],
      claude: Array.isArray(raw?.claude) ? raw.claude : [],
      gemini: Array.isArray(raw?.gemini) ? raw.gemini : [],
      antigravity: Array.isArray(raw?.antigravity) ? raw.antigravity : [],
      grok: Array.isArray(raw?.grok) ? raw.grok : [],
    };
  } catch {
    return { codex: [], claude: [], gemini: [], antigravity: [], grok: [] };
  }
}

/**
 * 判断当前是否允许读取 Claude Agent History。
 */
function getIndexedClaudeAgentHistorySetting(): boolean {
  try {
    const cached = (g.__indexer as any)?.claudeCodeReadAgentHistory;
    if (typeof cached === "boolean") return cached;
  } catch {}
  return getClaudeCodeReadAgentHistorySetting();
}

/**
 * 基于已探测 roots 或路径特征推断指定历史文件所属 Provider。
 */
function resolveProviderIdFromRoots(filePath: string, providerHint?: ProviderId): ProviderId {
  if (providerHint === "codex" || providerHint === "claude" || providerHint === "gemini" || providerHint === "antigravity" || providerHint === "grok") return providerHint;
  try {
    const f = canonicalKey(filePath);
    const rootsByProvider = getExistingRootsByProvider();
    let best: { providerId: ProviderId; len: number } | null = null;
    const entries: Array<{ providerId: ProviderId; root: string }> = [
      ...rootsByProvider.codex.map((root) => ({ providerId: "codex" as const, root })),
      ...rootsByProvider.claude.map((root) => ({ providerId: "claude" as const, root })),
      ...rootsByProvider.gemini.map((root) => ({ providerId: "gemini" as const, root })),
      ...rootsByProvider.antigravity.map((root) => ({ providerId: "antigravity" as const, root })),
      ...rootsByProvider.grok.map((root) => ({ providerId: "grok" as const, root })),
    ];
    for (const entry of entries) {
      const rootKey = canonicalKey(entry.root);
      if (!rootKey) continue;
      if (f === rootKey || f.startsWith(rootKey + "/")) {
        if (!best || rootKey.length > best.len) best = { providerId: entry.providerId, len: rootKey.length };
      }
    }
    if (best) return best.providerId;
    if (f.includes("/.claude/")) return "claude";
    if (f.includes("/.grok/sessions/")) return "grok";
    if (f.includes("/.gemini/antigravity-cli/")) return "antigravity";
    if (f.includes("/.gemini/")) return "gemini";
  } catch {}
  return "codex";
}

/**
 * 判断指定 Provider 是否支持索引该历史文件。
 */
function shouldIndexProviderFile(providerId: ProviderId, filePath: string): boolean {
  try {
    const base = path.basename(String(filePath || "")).toLowerCase();
    if (providerId === "codex") return base.endsWith(".jsonl");
    if (providerId === "claude") {
      if (!getIndexedClaudeAgentHistorySetting() && base.startsWith("agent-") && base.endsWith(".jsonl")) return false;
      return base.endsWith(".jsonl") || base.endsWith(".ndjson");
    }
    if (providerId === "gemini") return base.startsWith("session-") && (base.endsWith(".jsonl") || base.endsWith(".json"));
    if (providerId === "antigravity") return base.endsWith(".db") && !base.endsWith(".db-wal") && !base.endsWith(".db-shm");
    if (providerId === "grok") return base === "summary.json";
    return false;
  } catch {
    return false;
  }
}

/**
 * 将 Antigravity SQLite sidecar 文件归一到主 DB 文件。
 */
function normalizeAntigravityWatchPath(filePath: string): string {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  if (/\.db-(?:wal|shm)$/i.test(raw)) return raw.replace(/\.db-(?:wal|shm)$/i, ".db");
  return raw;
}

/**
 * 将通知里携带的 transcriptPath 规范化为主进程可直接访问的路径。
 */
export function resolveAccessibleHistoryFilePath(filePath: string, sourcePath?: string): string {
  try {
    const raw = String(filePath || "").trim();
    if (!raw) return "";
    if (raw.startsWith("/") && sourcePath && isUNCPath(sourcePath)) {
      const info = uncToWsl(sourcePath);
      if (info?.distro) {
        const mapped = wslToUNC(raw, info.distro);
        if (mapped) return mapped;
      }
    }
    return raw;
  } catch {
    return String(filePath || "").trim();
  }
}

/**
 * 解析指定 Provider 的历史详情（快速刷新场景统一走摘要模式）。
 */
async function parseDetailsForProvider(
  providerId: ProviderId,
  filePath: string,
  stat: fs.Stats,
  effectiveMtimeMs = Number(stat?.mtimeMs || 0),
): Promise<Details> {
  if (providerId === "claude") return await parseClaudeSessionFile(filePath, stat, { summaryOnly: true, maxLines: getIndexedClaudeAgentHistorySetting() ? 400 : 200 } as any);
  if (providerId === "gemini") {
    const parsed = await parseGeminiSessionFile(filePath, stat, { summaryOnly: true } as any) as Details;
    try {
      const hash = String((parsed as any)?.projectHash || "").toLowerCase();
      const map: Map<string, string> | undefined = (g.__indexer as any)?.geminiHashToCwd;
      if (hash && !String(parsed.cwd || "").trim() && map?.has(hash)) {
        const cwd = String(map.get(hash) || "").trim();
        if (cwd) return { ...parsed, cwd, dirKey: dirKeyFromCwd(cwd) };
      }
    } catch {}
    return parsed;
  }
  if (providerId === "antigravity")
    return await parseAntigravitySessionFile(filePath, stat, { summaryOnly: true, effectiveMtimeMs } as any);
  if (providerId === "grok") {
    const parsed = await parseGrokSessionFile(filePath, stat, { summaryOnly: true } as any) as Details;
    const date = Math.max(Number(parsed.date || 0), effectiveMtimeMs);
    return { ...parsed, date };
  }
  return await parseCodexDetails(filePath, stat, { summaryOnly: true });
}

export type HistoryReconcileResult = "unchanged" | "updated" | "filtered" | "missing" | "retry" | "not-ready";

type HistoryFileObservation = {
  filePath: string;
  stat: fs.Stats;
  signature: FileSig;
  effectiveMtimeMs: number;
};

/**
 * 将 Provider 的任意相关路径归一到索引使用的主文件路径。
 */
export function normalizeHistoryFileAnchor(providerId: ProviderId, filePath: string): string {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  if (providerId === "antigravity") return normalizeAntigravityWatchPath(raw);
  if (providerId === "grok") {
    const base = path.basename(raw).toLowerCase();
    if (base === "summary.json") return raw;
    if (base === "updates.jsonl") return path.join(path.dirname(raw), "summary.json");
    return path.join(path.dirname(raw), "summary.json");
  }
  return raw;
}

/**
 * 比较两份文件签名，兼容旧缓存中尚未包含辅助文件字段的记录。
 */
function isSameFileSignature(left: FileSig | undefined, right: FileSig): boolean {
  if (!left) return false;
  return Number(left.mtimeMs || 0) === Number(right.mtimeMs || 0)
    && Number(left.size || 0) === Number(right.size || 0)
    && Number(left.auxMtimeMs || 0) === Number(right.auxMtimeMs || 0)
    && Number(left.auxSize || 0) === Number(right.auxSize || 0);
}

/**
 * 读取解析器实际依赖的全部文件签名。
 */
async function observeHistoryFile(providerId: ProviderId, filePath: string): Promise<HistoryFileObservation | null> {
  const anchor = normalizeHistoryFileAnchor(providerId, filePath);
  if (!anchor || !shouldIndexProviderFile(providerId, anchor)) return null;
  const stat = await fsp.stat(anchor).catch(() => null as fs.Stats | null);
  if (!stat?.isFile()) return null;
  let auxMtimeMs = 0;
  let auxSize = 0;
  if (providerId === "antigravity" || providerId === "grok") {
    const auxPath = providerId === "antigravity" ? `${anchor}-wal` : path.join(path.dirname(anchor), "updates.jsonl");
    const auxStat = await fsp.stat(auxPath).catch(() => null as fs.Stats | null);
    if (auxStat?.isFile()) {
      auxMtimeMs = Number(auxStat.mtimeMs || 0);
      auxSize = Number(auxStat.size || 0);
    }
  }
  return {
    filePath: anchor,
    stat,
    signature: {
      mtimeMs: Number(stat.mtimeMs || 0),
      size: Number(stat.size || 0),
      auxMtimeMs,
      auxSize,
    },
    effectiveMtimeMs: Math.max(Number(stat.mtimeMs || 0), auxMtimeMs),
  };
}

/**
 * 根据详情对象构造索引摘要，统一各条增量路径的写入结果。
 */
function buildIndexSummary(providerId: ProviderId, filePath: string, details: Details): IndexSummary {
  return {
    providerId,
    id: details.id,
    title: details.title,
    date: details.date,
    filePath,
    rawDate: details.rawDate,
    dirKey: details.dirKey || dirKeyOf(filePath),
    preview: details.preview,
    projectHash: (details as any).projectHash,
    resumeMode: details.resumeMode,
    resumeId: details.resumeId,
    runtimeShell: details.runtimeShell && details.runtimeShell !== "unknown" ? details.runtimeShell : detectRuntimeShell(filePath),
    codexRelationship: details.codexRelationship,
  } as any;
}

/**
 * 对单个历史文件执行一次增量 upsert，并在必要时推送前端更新。
 */
async function upsertIndexedFile(
  filePath: string,
  providerHint?: ProviderId,
  isCurrent: () => boolean = () => true,
): Promise<HistoryReconcileResult> {
  const ix: PersistIndex | undefined = g.__indexer?.index;
  const det: PersistDetails | undefined = g.__indexer?.details;
  if (!ix || !det) return "not-ready";
  const rawPath = String(filePath || "").trim();
  if (!rawPath || !isCurrent()) return "retry";
  const providerId = resolveProviderIdFromRoots(rawPath, providerHint);
  const before = await observeHistoryFile(providerId, rawPath);
  if (!before) return "missing";
  const k = canonicalKey(before.filePath);
  const sig = before.signature;
  const prev = ix.files[k]?.sig;
  const previousSummary = ix.files[k]?.summary;
  const needsHistoryBase = providerId === "codex" && !!previousSummary?.codexRelationship?.historyBaseThreadId
    && !previousSummary.codexHistoryResolved;
  if (isSameFileSignature(prev, sig) && !needsHistoryBase) return "unchanged";

  if (providerId === "grok") {
    const visibility = await getGrokSessionVisibility(before.filePath);
    if (visibility === "unavailable") return "retry";
    if (visibility === "hidden") {
      if (!isCurrent()) return "retry";
      const existed = !!ix.files[k] || !!det.files[k];
      try { getDetailsCache().delete(k); } catch {}
      delete ix.files[k];
      delete det.files[k];
      if (existed) {
        ix.savedAt = Date.now();
        det.savedAt = Date.now();
        saveIndex(ix);
        saveDetails(det);
        safeWindowSend(getIndexerWindow(), "history:index:remove", { filePath: before.filePath }, { tag: "indexer", suppressMs: 1000 });
      }
      return "filtered";
    }
  }

  const details = await parseDetailsForProvider(providerId, before.filePath, before.stat, before.effectiveMtimeMs);
  const after = await observeHistoryFile(providerId, before.filePath);
  if (!after || !isSameFileSignature(before.signature, after.signature) || !isCurrent()) return "retry";
  if (providerId === "claude" && shouldIgnoreClaudeSession(details as any, getIndexedClaudeAgentHistorySetting())) {
    const existed = !!ix.files[k] || !!det.files[k];
    try { getDetailsCache().delete(k); } catch {}
    if (ix.files[k]) delete ix.files[k];
    if (det.files[k]) delete det.files[k];
    if (existed) {
      ix.savedAt = Date.now();
      det.savedAt = Date.now();
      saveIndex(ix);
      saveDetails(det);
      safeWindowSend(getIndexerWindow(), "history:index:remove", { filePath: before.filePath }, { tag: "indexer", suppressMs: 1000 });
    }
    return "filtered";
  }

  const slimDetails = stripDetailsForPersist(details);
  try { getDetailsCache().delete(k); } catch {}
  det.files[k] = { sig, details: slimDetails };
  ix.files[k] = { sig, summary: buildIndexSummary(providerId, before.filePath, details) };
  if (providerId === "codex") ix.files[k].summary.codexHistoryResolved = true;
  ix.savedAt = Date.now();
  det.savedAt = Date.now();
  saveIndex(ix);
  saveDetails(det);
  const item = providerId === "codex"
    ? getIndexedSummaries().find((summary) => summary.providerId === "codex" && summary.id === details.id)
    : ix.files[k].summary;
  if (item) safeWindowSend(getIndexerWindow(), "history:index:update", { item }, { tag: "indexer", suppressMs: 1000 });
  return "updated";
}

/**
 * 根据 notify 文件位置推导对应的会话根目录，尽量缩小快速扫描范围。
 */
export function deriveRefreshRootFromSource(providerId: ProviderId, sourcePath?: string): string {
  try {
    const p = String(sourcePath || "").trim();
    if (!p) return "";
    const dir = path.dirname(p);
    if (providerId === "codex") return path.join(dir, "sessions");
    if ((providerId === "claude" || providerId === "gemini") && path.basename(dir).toLowerCase() === "hooks") return path.dirname(dir);
    if (providerId === "antigravity" && path.basename(dir).toLowerCase() === "hooks") return path.join(path.dirname(dir), "conversations");
    if (providerId === "grok") {
      const normalized = p.replace(/\\/g, "/");
      const marker = normalized.toLowerCase().lastIndexOf("/.grok/");
      if (marker >= 0) return path.join(p.slice(0, marker + "/.grok".length), "sessions");
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * 将通知刷新请求转交给唯一历史校对器；保留此导出以兼容现有测试和外部调用。
 */
export function requestHistoryFastRefresh(req: HistoryFastRefreshRequest): void {
  try {
    historyReconcilerRuntimePort?.requestFastRefresh(req);
  } catch (error) {
    try { perfLogger.log(`[indexer] history reconciler request failed error=${String(error)}`); } catch {}
  }
}

/**
 * 对外暴露稳定的单文件校对端口，供历史校对器复用索引器提交逻辑。
 */
export async function reconcileIndexedHistoryFile(
  filePath: string,
  providerHint?: ProviderId,
  isCurrent: () => boolean = () => true,
): Promise<HistoryReconcileResult> {
  try { return await upsertIndexedFile(filePath, providerHint, isCurrent); } catch { return "retry"; }
}

/**
 * 返回校对器需要的根目录、索引文件和 Codex 关系状态快照。
 */
export function getHistoryReconcileSnapshot(): {
  ready: boolean;
  rootsByProvider: Record<ProviderId, string[]>;
  existingRootsByProvider: Record<ProviderId, string[]>;
  files: Array<{ providerId: ProviderId; id: string; filePath: string; mtimeMs: number }>;
} {
  /** 创建空的 Provider 根目录映射。 */
  const emptyRoots = (): Record<ProviderId, string[]> => ({ codex: [], claude: [], gemini: [], antigravity: [], grok: [] });
  /** 从全局索引状态读取并复制根目录映射。 */
  const readRoots = (raw: any): Record<ProviderId, string[]> => {
    const roots = emptyRoots();
    for (const providerId of Object.keys(roots) as ProviderId[])
      roots[providerId] = Array.isArray(raw?.[providerId]) ? raw[providerId].slice() : [];
    return roots;
  };
  const roots = readRoots(g.__indexer?.rootsByProvider);
  const existingRoots = readRoots(g.__indexer?.existingRootsByProvider);
  const ix: PersistIndex = g.__indexer?.index || { version: VERSION, files: {}, savedAt: 0 };
  const files = Object.values(ix.files || {}).map((entry) => ({
    providerId: String((entry.summary as any)?.providerId || "codex") as ProviderId,
    id: String((entry.summary as any)?.id || ""),
    filePath: String((entry.summary as any)?.filePath || ""),
    mtimeMs: Number(entry.sig?.mtimeMs || 0),
  })).filter((entry) => entry.filePath);
  return {
    ready: getCodexRelationIndexState().ready,
    rootsByProvider: roots,
    existingRootsByProvider: existingRoots,
    files,
  };
}

/**
 * 暴露 Provider 文件筛选窄端口，供历史协调器复用 Claude 配置过滤规则。
 */
export function shouldIndexHistoryFile(providerId: ProviderId, filePath: string): boolean {
  return shouldIndexProviderFile(providerId, filePath);
}

/**
 * 返回稳定目录遍历未观察到的直属索引文件，不在索引器内执行文件系统 I/O。
 */
export function listIndexedHistoryFilesForRemovalAfterSweep(
  providerId: ProviderId,
  parentDir: string,
  observedFiles: ReadonlySet<string>,
): string[] {
  const ix: PersistIndex | undefined = g.__indexer?.index;
  if (!ix) return [];
  const parentKey = canonicalKey(parentDir).replace(/\/$/, "");
  return Object.values(ix.files || {}).filter((entry) => {
    const summary: any = entry.summary;
    return String(summary?.providerId || "codex") === providerId
      && path.dirname(canonicalKey(String(summary?.filePath || ""))) === parentKey;
  }).map((entry) => String((entry.summary as any)?.filePath || ""))
    .filter((filePath) => !!filePath && !observedFiles.has(canonicalKey(filePath)));
}

/**
 * 提交已经由协调器确认 ENOENT 的索引文件，并发送增量移除事件。
 */
export function commitIndexedHistoryFilesRemovedAfterSweep(
  providerId: ProviderId,
  missingFiles: readonly string[],
  isCurrent: () => boolean = () => true,
): number {
  if (!isCurrent() || missingFiles.length === 0) return 0;
  const ix: PersistIndex | undefined = g.__indexer?.index;
  const det: PersistDetails | undefined = g.__indexer?.details;
  if (!ix || !det) return 0;
  let removed = 0;
  for (const filePath of missingFiles) {
    if (!isCurrent()) break;
    const key = canonicalKey(filePath);
    const summary = ix.files[key]?.summary as IndexSummary | undefined;
    if (String(summary?.providerId || "codex") !== providerId) continue;
    const existed = !!ix.files[key] || !!det.files[key];
    try { getDetailsCache().delete(key); } catch {}
    delete ix.files[key];
    delete det.files[key];
    if (existed) {
      removed++;
      safeWindowSend(getIndexerWindow(), "history:index:remove", { filePath }, { tag: "indexer", suppressMs: 1000 });
    }
  }
  if (removed > 0) {
    ix.savedAt = Date.now();
    det.savedAt = Date.now();
    saveIndex(ix);
    saveDetails(det);
  }
  return removed;
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
    return tidyPathCandidateShared(v);
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
    if (/^[a-zA-Z]:\\(?:[^\r\n\t"'<>{}|?*]+)?$/.test(s)) return true; // 盘符（含根目录 C:\）
    if (/^\\\\[^\s"'\\]+\\[^\s"'\\]+/.test(s)) return true; // UNC
    if (/^\/mnt\/[a-zA-Z](?:\/.*)?$/.test(s)) return true; // /mnt/<drive>（含盘根目录）
    if (/^\/[\w._-]+\//.test(s)) return true; // 其他 POSIX 根
    if (s === "/") return true;
    return false;
  } catch { return false; }
}

function dirKeyOf(filePath: string): string {
  try {
    return dirKeyOfFilePathShared(filePath);
  } catch { return filePath; }
}

// 从 CWD 直接计算 dirKey（不降一级）
function dirKeyFromCwd(dirPath: string): string {
  try {
    return dirKeyFromCwdShared(dirPath);
  } catch { return dirPath; }
}

/**
 * 中文说明：统一判断某条历史记录是否仍在使用“文件所在目录”作为项目归属兜底。
 * 这用于：
 * - 决定是否继续重试解析 cwd；
 * - 让诊断日志与实际归属判定保持一致。
 */
function analyzeDirKeyResolution(filePath: string, cwd?: string, dirKey?: string): DirKeyResolutionState {
  const normalizedCwd = tidyPathCandidate(typeof cwd === "string" ? cwd : "");
  const fallbackDirKey = dirKeyOf(filePath);
  const resolvedDirKey = String(dirKey || "").trim() || fallbackDirKey;
  const hasCwd = !!normalizedCwd;
  const usesFallbackDir = !resolvedDirKey || resolvedDirKey === fallbackDirKey;
  return { normalizedCwd, resolvedDirKey, fallbackDirKey, hasCwd, usesFallbackDir };
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
  let codexRelationship: CodexSessionRelationship | undefined;
  let prefixAcc: string = ""; // 前缀累积用于提取 <cwd> 或 CWD 行
  const chunk = 256 * 1024;
  const historyStream = await openCodexHistoryStream(fp, chunk);
  // 说明类去重：会话头 instructions 与用户 <user_instructions> 可能重复
  const __seenInstructions = new Set<string>();
  const __normInstr = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pushMessage = (msg: Message) => {
    if (!summaryOnly) messages.push(msg);
  };
  /**
   * 生成 Codex 详情标题：没有线程名或显式标题时，用已过滤的首条用户预览替代文件名。
   */
  const resolveCodexDetailsTitle = (): string => {
    const fallbackTitle = titleFromFilename(fp);
    if (preview && (!title || title === fallbackTitle)) {
      return preview.length > 96 ? `${preview.slice(0, 95)}…` : preview;
    }
    return title;
  };
  /**
   * 判断消息内容是否只包含子代理通知。
   */
  const isSubagentNotificationOnlyContent = (contentArr: MessageContent[] | null | undefined): boolean => {
    const items = Array.isArray(contentArr) ? contentArr : [];
    if (items.length === 0) return false;
    return items.every((item) => String(item?.type || "").trim().toLowerCase() === "subagent_notification");
  };
  /**
   * 将纯子代理通知的 Codex 历史角色规整为 notification。
   */
  const normalizeCodexDetailsRoleForContent = (role: unknown, contentArr: MessageContent[]): string => {
    const rawRole = String(role || "").trim() || "user";
    if (rawRole.toLowerCase() === "user" && isSubagentNotificationOnlyContent(contentArr)) return "notification";
    return rawRole;
  };
  return await new Promise<Details>((resolve) => {
    try {
      const rs = historyStream;
      let lineIndex = 0;
      let buf = "";

      const pretty = (v: any) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
      const flushLines = (text: string) => {
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const threadName = extractCodexThreadNameFromRecord(obj);
            if (threadName) {
              title = threadName;
              preview = threadName.slice(0, HISTORY_PREVIEW_SEARCH_MAX_CHARS);
            }
            if (runtimeShell === 'unknown') {
              const hint = detectRuntimeShellFromContent(obj, prefixAcc);
              if (hint !== 'unknown') runtimeShell = hint;
            }
            if (lineIndex === 0) {
              codexRelationship = extractCodexSessionRelationship(obj);
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
                        const filtered = filterCodexHistoryPreviewText(t);
                        if (filtered) { preview = filtered.slice(0, HISTORY_PREVIEW_SEARCH_MAX_CHARS); break; }
                      }
                    }
                  }
                  if (!preview) {
                    for (const it of items) {
                      const ty = String((it as any)?.type || '').toLowerCase();
                      if (ty === 'instructions' || ty === 'environment_context') continue;
                      const t = String((it as any)?.text || '').trim();
                      if (t) {
                        const filtered = filterCodexHistoryPreviewText(t);
                        if (filtered) { preview = filtered.slice(0, HISTORY_PREVIEW_SEARCH_MAX_CHARS); break; }
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
                pushMessage({ role: normalizeCodexDetailsRoleForContent(role, items), content: items });
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
        resolve({ providerId: "codex", id, title: resolveCodexDetailsTitle(), date, filePath: fp, messages, skippedLines: skipped, rawDate, cwd, dirKey, preview, resumeMode, resumeId: finalResumeId, runtimeShell, codexRelationship });
      });
      rs.on('error', () => {
        if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
        const finalResumeId = resumeId || id;
        resolve({ providerId: "codex", id, title: resolveCodexDetailsTitle(), date, filePath: fp, messages, skippedLines: skipped, rawDate, cwd, dirKey, preview, resumeMode, resumeId: finalResumeId, runtimeShell, codexRelationship });
      });
    } catch {
      if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
      const finalResumeId = resumeId || id;
      resolve({ providerId: "codex", id, title: resolveCodexDetailsTitle(), date, filePath: fp, messages, skippedLines: skipped, resumeMode, resumeId: finalResumeId, runtimeShell, codexRelationship });
    }
  });
}

// 全局索引状态在文件头部初始化

export function getIndexedSummaries(): IndexSummary[] {
  const ix: PersistIndex = g.__indexer.index || { version: VERSION, files: {}, savedAt: 0 };
  const cached = g.__indexer.indexedSummaryCache as IndexedSummaryCache | undefined;
  if (cached?.index === ix) return cached.summaries;

  const summaries = selectCurrentHistorySummaries(Object.values(ix.files)
    .map((x) => {
      const summary = x.summary as any;
      const providerId: ProviderId = (summary && typeof summary.providerId === "string")
        ? (summary.providerId as ProviderId)
        : "codex";
      const shell = summary.runtimeShell && summary.runtimeShell !== 'unknown' ? summary.runtimeShell : detectRuntimeShell(summary.filePath);
      return { ...summary, providerId, runtimeShell: shell } as IndexSummary;
    })
  );
  g.__indexer.indexedSummaryCache = { index: ix, summaries } as IndexedSummaryCache;
  return summaries;
}

/**
 * 从内存索引生成 Codex 会话关系快照，避免打开删除确认时重新遍历全部 JSONL 文件。
 */
export function getIndexedCodexSessionRecords(): CodexSessionRecord[] {
  const ix: PersistIndex = g.__indexer.index || { version: VERSION, files: {}, savedAt: 0 };
  const records: CodexSessionRecord[] = [];
  for (const entry of Object.values(ix.files)) {
    const summary = entry?.summary as IndexSummary | undefined;
    const providerId = summary?.providerId || "codex";
    const id = String(summary?.id || "").trim().toLowerCase();
    const filePath = String(summary?.filePath || "").trim();
    const relationship = summary?.codexRelationship;
    if (providerId !== "codex" || !id || !filePath || !relationship || relationship.kind === "unknown") continue;
    records.push({
      id,
      filePath,
      mtimeMs: Number(entry.sig?.mtimeMs || 0),
      size: Number(entry.sig?.size || 0),
      relationship,
    });
  }
  return records;
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

/**
 * 创建空的 Provider 根目录映射。
 */
function createEmptyProviderRoots(): Record<ProviderId, string[]> {
  return { codex: [], claude: [], gemini: [], antigravity: [], grok: [] };
}

/**
 * 复制全局状态中的 Provider 根目录映射，避免异步发现结果互相覆盖。
 */
function copyProviderRoots(raw: any): Record<ProviderId, string[]> {
  const roots = createEmptyProviderRoots();
  for (const providerId of Object.keys(roots) as ProviderId[])
    roots[providerId] = Array.isArray(raw?.[providerId]) ? raw[providerId].slice() : [];
  return roots;
}

/**
 * 清理设置为不读取时遗留的 Claude 子代理与空壳历史项。
 */
function purgeIgnoredClaudeHistory(isCurrent: () => boolean): void {
  if (getClaudeCodeReadAgentHistorySetting() || !isCurrent()) return;
  try {
    const ix: PersistIndex = g.__indexer.index;
    const det: PersistDetails = g.__indexer.details;
    let removed = 0;
    for (const [key, entry] of Object.entries(ix.files || {})) {
      if (!isCurrent()) return;
      const summary: any = (entry as any)?.summary;
      if (String(summary?.providerId || "").toLowerCase() !== "claude") continue;
      const filePath = String(summary?.filePath || "");
      const preview = typeof summary?.preview === "string" ? summary.preview.trim() : "";
      const title = typeof summary?.title === "string" ? summary.title : "";
      const base = filePath ? path.basename(filePath) : "";
      const assistantOnly = !preview && !!base && (!title || title === base);
      if (!isClaudeAgentHistoryFilePath(filePath) && !assistantOnly) continue;
      delete ix.files[key];
      delete det.files[key];
      removed++;
    }
    if (removed <= 0 || !isCurrent()) return;
    ix.savedAt = Date.now();
    det.savedAt = Date.now();
    saveIndex(ix);
    saveDetails(det);
    idxLog(`[purge] removed=${removed} (claude agent/assistant-only) because readAgentHistory=false`);
  } catch {}
}

/**
 * 从项目缓存构建 Gemini projectHash 到工作目录的映射。
 */
async function loadGeminiHashToCwd(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const projectsPath = path.join(getUserDataDir(), "projects.json");
    const rawText = (await fsp.readFile(projectsPath, "utf8").catch(() => "")).replace(/^\uFEFF/, "");
    const items: any[] = rawText ? JSON.parse(rawText) : [];
    /** 将一个项目路径登记为 Gemini 可识别的 hash 候选。 */
    const register = (value?: unknown, kind?: "win" | "wsl"): void => {
      if (typeof value !== "string") return;
      const candidate = tidyPathCandidate(value);
      if (!candidate) return;
      for (const hash of deriveGeminiProjectHashCandidatesFromPath(candidate))
        if (hash && !result.has(hash)) result.set(hash, candidate);
      if (kind !== "wsl") return;
      const match = candidate.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (!match) return;
      const windowsPath = `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
      for (const hash of deriveGeminiProjectHashCandidatesFromPath(windowsPath))
        if (hash && !result.has(hash)) result.set(hash, windowsPath);
    };
    for (const item of Array.isArray(items) ? items : []) {
      register(item?.wslPath, "wsl");
      register(item?.winPath, "win");
    }
  } catch {}
  return result;
}

/**
 * 启动单个 Provider 的免存在性探测任务，避免 UNC stat 阻塞候选发布。
 */
function getHistoryRootDiscoveryTask(providerId: ProviderId): Promise<SessionsRootCandidate[]> {
  try {
    if (providerId === "codex") return getSessionsRootCandidatesFastAsync(false);
    if (providerId === "claude") return getClaudeRootCandidatesFastAsync(false);
    if (providerId === "gemini") return getGeminiRootCandidatesFastAsync(false);
    if (providerId === "antigravity") return getAntigravityRootCandidatesFastAsync(false);
    return getGrokRootCandidatesFastAsync(false);
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * 立即返回本机 Provider 根候选，避免 WSL 根探测阻塞本地历史刷新。
 */
function getImmediateLocalHistoryRootCandidates(providerId: ProviderId): SessionsRootCandidate[] {
  const paths: string[] = [];
  const add = (value?: string): void => {
    const normalized = String(value || "").trim();
    if (normalized) paths.push(normalized);
  };
  if (providerId === "codex") {
    add(path.join(os.homedir(), ".codex", "sessions"));
  } else if (providerId === "claude") {
    add(process.env.CLAUDE_HOME);
    add(process.env.CLAUDE_CONFIG_DIR);
    add(path.join(os.homedir(), ".claude"));
  } else if (providerId === "gemini") {
    const cliHome = String(process.env.GEMINI_CLI_HOME || "").trim();
    const home = String(process.env.GEMINI_HOME || "").trim();
    if (cliHome) add(path.join(cliHome, "tmp"));
    if (home) add(path.join(home, "tmp"));
    add(path.join(os.homedir(), ".gemini", "tmp"));
  } else if (providerId === "antigravity") {
    const antigravityHome = String(process.env.ANTIGRAVITY_HOME || "").trim();
    const geminiHome = String(process.env.GEMINI_HOME || "").trim();
    if (antigravityHome) add(path.join(antigravityHome, "conversations"));
    if (geminiHome) add(path.join(geminiHome, "antigravity-cli", "conversations"));
    add(path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations"));
  } else {
    const grokHome = String(process.env.GROK_HOME || "").trim();
    if (grokHome) add(path.join(grokHome, "sessions"));
    add(path.join(os.homedir(), ".grok", "sessions"));
  }
  return Array.from(new Set(paths)).map((rootPath) => ({
    path: rootPath,
    exists: true,
    source: "windows",
    kind: "local",
  }));
}

/**
 * 发布单个 Provider 的候选根，并请求协调器开始受限扫描。
 */
function publishHistoryRootCandidates(
  providerId: ProviderId,
  candidates: readonly SessionsRootCandidate[],
  isCurrent: () => boolean,
): void {
  if (!isCurrent()) return;
  const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));
  const allRoots = copyProviderRoots(g.__indexer?.rootsByProvider);
  const existingRoots = copyProviderRoots(g.__indexer?.existingRootsByProvider);
  const missingRoots = copyProviderRoots(g.__indexer?.missingRootsByProvider);
  allRoots[providerId] = unique([...allRoots[providerId], ...candidates.map((candidate) => candidate.path)]);
  existingRoots[providerId] = unique([...existingRoots[providerId], ...candidates.filter((candidate) => candidate.exists).map((candidate) => candidate.path)]);
  missingRoots[providerId] = unique([...missingRoots[providerId], ...candidates.filter((candidate) => !candidate.exists).map((candidate) => candidate.path)]);
  if (!isCurrent()) return;
  g.__indexer.rootsByProvider = allRoots;
  g.__indexer.existingRootsByProvider = existingRoots;
  g.__indexer.missingRootsByProvider = missingRoots;
  if (providerId === "codex") {
    g.__indexer.roots = allRoots.codex.slice();
    g.__indexer.existingRoots = existingRoots.codex.slice();
    g.__indexer.missingRoots = missingRoots.codex.slice();
  }
  perfLogger.log(`[roots] ${providerId}.existing=${JSON.stringify(existingRoots[providerId])} ${providerId}.missing=${JSON.stringify(missingRoots[providerId])}`);
}

/**
 * 后台发现各 Provider 根目录；迟到结果只有在启动代次仍有效时才允许发布。
 */
function scheduleHistoryRootDiscovery(
  lifecycleGeneration: number,
  reconcilerGeneration: number,
  reconciler: typeof import("./historyReconciler"),
): void {
  const isCurrent = () => historyIndexerLifecycleGeneration === lifecycleGeneration
    && reconciler.isHistoryReconcilerGenerationCurrent(reconcilerGeneration);
  const seededRoots = new Set<string>();
  /** 在后台批量恢复官方摘要，分片合并以免大量记录占住主线程。 */
  const seedCodexRoots = async (candidates: readonly SessionsRootCandidate[]): Promise<void> => {
    const roots = candidates.map((candidate) => candidate.path).filter((root) => !seededRoots.has(root));
    for (const root of roots) seededRoots.add(root);
    const entries = await loadCodexStateSnapshot(roots);
    const ix: PersistIndex | undefined = g.__indexer?.index;
    if (!isCurrent() || !ix) return;
    let added = 0;
    let updated = 0;
    for (let offset = 0; offset < entries.length; offset += 128) {
      if (!isCurrent()) return;
      for (const entry of entries.slice(offset, offset + 128)) {
        const key = canonicalKey(entry.summary.filePath);
        const previous = ix.files[key];
        if (previous) {
          const sameMtime = previous.sig.mtimeMs === entry.sig.mtimeMs;
          // 已完成的解析优先保留；迟到快照不能覆盖本轮刚更新的文件。
          if (previous.sig.mtimeMs > entry.sig.mtimeMs
            || (sameMtime && previous.sig.size > entry.sig.size)
            || (sameMtime && previous.sig.size === entry.sig.size && previous.summary.codexHistoryResolved)) continue;
        }
        ix.files[key] = { sig: entry.sig, summary: { ...entry.summary, dirKey: entry.summary.dirKey || "", codexHistoryResolved: true } };
        if (previous) updated++;
        else added++;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!isCurrent() || (!added && !updated)) return;
    ix.savedAt = Date.now();
    saveIndex(ix);
    safeWindowSend(getIndexerWindow(), "history:index:invalidate", { reason: "codex-state-snapshot" }, { tag: "indexer", suppressMs: 1000 });
    perfLogger.log(`[indexer] codexStateSnapshot added=${added} updated=${updated}`);
  };
  for (const providerId of ["codex", "claude", "gemini", "antigravity", "grok"] as ProviderId[]) {
    const immediate = getImmediateLocalHistoryRootCandidates(providerId);
    publishHistoryRootCandidates(providerId, immediate, isCurrent);
    if (providerId === "codex") void seedCodexRoots(immediate).catch(() => {});
    void getHistoryRootDiscoveryTask(providerId).then((candidates) => {
      publishHistoryRootCandidates(providerId, candidates, isCurrent);
      if (providerId === "codex" && isCurrent()) void seedCodexRoots(candidates).catch(() => {});
      if (isCurrent()) reconciler.requestHistoryReconcileNow(`roots-discovered:${providerId}`);
    }).catch((error) => {
      if (isCurrent()) idxLog(`[roots] provider=${providerId} discovery failed error=${String(error)}`);
    });
  }
}

/**
 * 串行启动历史索引器；初始化仅加载本地缓存，目录发现与解析交给协调器后台执行。
 */
export function startHistoryIndexer(getWindow: () => BrowserWindow | null): Promise<void> {
  const lifecycleGeneration = ++historyIndexerLifecycleGeneration;
  const pauseTask = import("./historyReconciler")
    .then(async (reconciler) => await reconciler.pauseHistoryReconciler())
    .catch(() => 0);
  const operation = historyIndexerLifecycleQueue.catch(() => undefined).then(async () => {
    await pauseTask;
    if (historyIndexerLifecycleGeneration !== lifecycleGeneration) return;

    const reconciler = await import("./historyReconciler");
    const reconcilerGeneration = await reconciler.beginHistoryReconcilerInitialization();
    const isCurrent = () => historyIndexerLifecycleGeneration === lifecycleGeneration
      && reconciler.isHistoryReconcilerGenerationCurrent(reconcilerGeneration);
    if (!isCurrent()) return;

    resetCodexRelationIndexState();
    setIndexerWindowGetter(getWindow);
    await perfLogger.time("indexer.start", async () => {
      const removedLegacyPersistFiles = purgeLegacyPersistFiles();
      if (idxDbgEnabled()) {
        perfLogger.log(`[indexer] cacheVersion=${VERSION} userData=${JSON.stringify(getUserDataDir())}`);
        if (removedLegacyPersistFiles.length > 0)
          perfLogger.log(`[indexer] purgedLegacyCaches=${JSON.stringify(removedLegacyPersistFiles)}`);
      }

      await ensureHistoryIndexLoaded();
      if (!isCurrent()) return;
      const details = await loadDetails();
      if (!isCurrent()) return;
      g.__indexer.details = details;
      try { getDetailsCache().clear(); } catch {}

      const claudeCodeReadAgentHistory = getClaudeCodeReadAgentHistorySetting();
      g.__indexer.claudeCodeReadAgentHistory = claudeCodeReadAgentHistory;
      purgeIgnoredClaudeHistory(isCurrent);
      if (!isCurrent()) return;

      const geminiHashToCwd = await loadGeminiHashToCwd();
      if (!isCurrent()) return;
      g.__indexer.geminiHashToCwd = geminiHashToCwd;
      g.__indexer.roots = [];
      g.__indexer.existingRoots = [];
      g.__indexer.missingRoots = [];
      g.__indexer.rootsByProvider = createEmptyProviderRoots();
      g.__indexer.existingRootsByProvider = createEmptyProviderRoots();
      g.__indexer.missingRootsByProvider = createEmptyProviderRoots();

      setCodexRelationIndexReady(true);
      if (!reconciler.markHistoryReconcilerReady(reconcilerGeneration)) {
        resetCodexRelationIndexState();
        return;
      }
      scheduleHistoryRootDiscovery(lifecycleGeneration, reconcilerGeneration, reconciler);
    });
  });
  historyIndexerLifecycleQueue = operation.catch(() => undefined);
  return operation;
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

/**
 * 批量清理索引与详情缓存，避免关联删除时为每个文件重复安排持久化写入。
 */
export function removeFromIndexMany(filePaths: readonly string[]): number {
  try {
    const ix: PersistIndex = g.__indexer.index || { version: VERSION, files: {}, savedAt: 0 };
    const det: PersistDetails = g.__indexer.details || { version: VERSION, files: {}, savedAt: 0 };
    const keys = new Set((filePaths || []).map((filePath) => canonicalKey(String(filePath || ""))).filter(Boolean));
    let removed = 0;
    for (const k of keys) {
      const existed = !!ix.files[k] || !!det.files[k];
      try { getDetailsCache().delete(k); } catch {}
      if (ix.files[k]) delete ix.files[k];
      if (det.files[k]) delete det.files[k];
      if (existed) removed++;
    }
    if (removed > 0) {
      ix.savedAt = Date.now();
      det.savedAt = Date.now();
      saveIndex(ix);
      saveDetails(det);
    }
    return removed;
  } catch { return 0; }
}

// 供主进程在删除文件后主动清理索引与详情缓存，避免切换项目时已删除项回流
export function removeFromIndex(filePath: string): boolean {
  return removeFromIndexMany([filePath]) > 0;
}

/**
 * 立即废弃当前代次，并在串行队列中完成缓存刷盘和窗口引用清理。
 */
export function stopHistoryIndexer(): Promise<void> {
  const lifecycleGeneration = ++historyIndexerLifecycleGeneration;
  const pauseTask = import("./historyReconciler")
    .then(async (reconciler) => await reconciler.pauseHistoryReconciler())
    .catch(() => 0);
  const operation = historyIndexerLifecycleQueue.catch(() => undefined).then(async () => {
    await pauseTask;
    if (historyIndexerLifecycleGeneration !== lifecycleGeneration) return;
    try { resetCodexRelationIndexState(); } catch {}
    try { await flushPersistWrites(true); } catch {}
    if (historyIndexerLifecycleGeneration !== lifecycleGeneration) return;
    g.__indexer.roots = [];
    g.__indexer.existingRoots = [];
    g.__indexer.missingRoots = [];
    g.__indexer.rootsByProvider = createEmptyProviderRoots();
    g.__indexer.existingRootsByProvider = createEmptyProviderRoots();
    g.__indexer.missingRootsByProvider = createEmptyProviderRoots();
    try { setIndexerWindowGetter(null); } catch {}
  });
  historyIndexerLifecycleQueue = operation.catch(() => undefined);
  return operation;
}
