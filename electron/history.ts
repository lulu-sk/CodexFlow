// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { app } from 'electron';
import { getDebugConfig } from './debugConfig';
import crypto from 'node:crypto';
import { isUNCPath, uncToWsl, getSessionsRootsFastAsync } from './wsl';
import { perfLogger } from './log';
import settings from './settings';
import { extractTaggedPrefix } from './agentSessions/shared/taggedPrefix';
import { createHistoryImageContent, extractImagePathCandidatesFromText } from './agentSessions/shared/historyImage';
import { deriveGeminiProjectHashCandidatesFromPath, extractGeminiProjectHashFromPath } from './agentSessions/gemini/parser';
import { filterCodexHistoryPreviewText } from './agentSessions/shared/preview';
import { pathMatchesDirKeyScope, tidyPathCandidate } from "./agentSessions/shared/path";
import { extractCodexSessionRelationship, type CodexSessionRelationship } from "./codexSessionRelations";
import { openCodexHistoryStream, selectCurrentHistorySummaries } from "./codexRollout";
import { readBufferHistoryLines } from "./historyLineReader";

/**
 * History 读取模块: 支持逐行解析 JSONL, list/read 接口
 */

export type RuntimeShell = 'wsl' | 'windows' | 'unknown';

export type ProviderId = 'codex' | 'claude' | 'gemini' | 'antigravity' | 'grok';

export type HistorySummary = {
  providerId: ProviderId;
  id: string;
  title: string;
  date: number;
  filePath: string;
  rawDate?: string;
  preview?: string;
  dirKey?: string;
  projectHash?: string;
  resumeMode?: 'modern' | 'legacy' | 'unknown';
  resumeId?: string;
  runtimeShell?: RuntimeShell;
  codexRelationship?: CodexSessionRelationship;
};
// 消息内容：支持可选 tags（用于嵌套类型筛选，例如 message.input_text）
export type MessageContent = {
  type: string;
  text: string;
  tags?: string[];
  src?: string;
  fallbackSrc?: string;
  localPath?: string;
  mimeType?: string;
  /** 文件差异对应的会话工作目录，用于把路径显示为相对路径。 */
  cwd?: string;
  /** 文件差异来源，供前端区分标准差异与 FileChange 回退记录。 */
  diffSource?: 'apply_patch' | 'file_change' | 'turn_diff';
  /** 当前差异是否可以安全交给 Git/apply_patch 执行撤销或重新应用。 */
  patchable?: boolean;
};
export type Message = {
  role: string;
  content: MessageContent[];
  /** 用户轮次标识，与模型单次请求的内部标识区分。 */
  turnId?: string;
  /** Codex 原始输出阶段，例如 commentary 或 final_answer。 */
  phase?: string;
  /** 记录的原始时间，供历史详情计算执行过程的用时。 */
  timestamp?: string;
  /** 明确开始、结束事件之间的轮次用时。 */
  durationMs?: number;
};

// 历史摘要前缀与缓存上限（控制内存占用）
const SUMMARY_PREFIX_BYTES = 48 * 1024; // 仅保留文件头 48KB，用于提取 metadata / cwd 提示
const SUMMARY_THREAD_NAME_SCAN_BYTES = 8 * 1024 * 1024; // 额外扫描上限，仅用于定位 Codex thread_name_updated
const SUMMARY_CACHE_MAX_ENTRIES = 800;

/**
 * 将路径快速规范化为“WSL 风格”的可对比 key（不调用 wsl.exe）。
 *
 * 目的：
 * - history 扫描属于热路径；若调用 `wsl.exe wslpath` 会在文件量大时导致严重卡顿与日志刷屏。
 * - 这里仅做字符串规则转换：UNC -> /home/...，盘符 -> /mnt/<drive>/...，并统一斜杠与大小写。
 */
function toWslLikePathKey(input?: string): string {
  try {
    let s = String(input || "").trim();
    if (!s) return "";
    // 先清理常见的 JSON/日志噪声，保持与调用方一致
    s = tidyPathCandidate(s);
    if (!s) return "";

    if (isUNCPath(s)) {
      const info = uncToWsl(s);
      if (info?.wslPath) s = info.wslPath;
    } else {
      // 仅对盘符绝对路径做规则转换（避免误把 C:relative 之类的字符串当作绝对路径）
      const winLike = s.replace(/\//g, "\\");
      const m = winLike.match(/^([a-zA-Z]):(?:\\(.*))?$/);
      if (m) {
        const drive = m[1].toLowerCase();
        const rest = String(m[2] || "").replace(/\\/g, "/");
        s = rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
      }
    }

    let out = s.replace(/\\/g, "/");
    out = out.replace(/\/+/g, "/");
    out = out.replace(/\/+$/, "");
    return out.toLowerCase();
  } catch {
    return String(input || "").trim().toLowerCase();
  }
}

/**
 * 中文说明：将历史中的路径候选统一规范化为可做项目归属匹配的 key。
 */
function canonicalizeHistoryPathForMatch(input?: string): string {
  try {
    let s = tidyPathCandidate(String(input || ''));
    if (isUNCPath(s)) {
      const info = uncToWsl(s);
      if (info) {
        let x = info.wslPath.split('\\').join('/');
        while (x.includes('//')) x = x.replace('//', '/');
        return x.toLowerCase();
      }
    }
    if (/^[a-zA-Z]:(?:\\|$)/.test(s)) {
      const x = toWslLikePathKey(s);
      if (x) return x;
    }
    let out = s.split('\\').join('/');
    while (out.includes('//')) out = out.replace('//', '/');
    return out.toLowerCase();
  } catch {
    let out = String(input || '').split('\\').join('/');
    while (out.includes('//')) out = out.replace('//', '/');
    return out.toLowerCase();
  }
}

function trimPrefixForCache(prefix: string): string {
  if (!prefix) return "";
  return prefix.length > SUMMARY_PREFIX_BYTES ? prefix.slice(0, SUMMARY_PREFIX_BYTES) : prefix;
}

function shrinkSummaryCache(cache: Map<string, unknown>, limit = SUMMARY_CACHE_MAX_ENTRIES): void {
  try {
    while (cache.size > limit) {
      const first = cache.keys().next().value as string | undefined;
      if (!first) break;
      cache.delete(first);
    }
  } catch {}
}

async function readPrefixChunk(fp: string, maxBytes = SUMMARY_PREFIX_BYTES): Promise<string> {
  return await new Promise((resolve) => {
    try {
      const rs = fs.createReadStream(fp, { encoding: 'utf8', start: 0, end: Math.max(0, maxBytes - 1) });
      let buf = '';
      rs.on('data', (c) => {
        buf += c;
        if (buf.length >= maxBytes) {
          try { rs.close(); } catch {}
          resolve(buf.slice(0, maxBytes));
        }
      });
      rs.on('end', () => resolve(buf.slice(0, maxBytes)));
      rs.on('error', () => resolve(''));
    } catch { resolve(''); }
  });
}

/**
 * 从历史文件路径推断运行环境（WSL / Windows / unknown）。
 * 用途：用于“继续对话”时的跨环境阻断提示，需要兼容 Windows 盘符路径与 UNC 路径的多种写法。
 */
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
    const collapsed = replaced.replace(/\/+/g, '/');
    if (collapsed.startsWith('/mnt/')) return 'wsl';
    if (collapsed.startsWith('/home/') || collapsed.startsWith('/root/')) return 'wsl';
    // Windows 盘符路径：兼容 C:\... 与 C:/... 两种分隔符
    if (/^[a-z]:[\\/]/i.test(raw) || /^[a-z]:\//i.test(collapsed)) return 'windows';
    // 其他 UNC / 网络共享：归类为 Windows（例如 \\server\share\... 或 //server/share/...）
    if (raw.startsWith('\\\\') || replaced.startsWith('//')) return 'windows';
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
function __envFlag(): string { try { return getDebugConfig().history.debug ? '1' : ''; } catch { return ''; } }
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

/**
 * 中文说明：将标题压缩为适合列表展示的一行文本。
 */
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

type PrefixTitleParts = { threadName?: string; user?: string; assistant?: string };

/**
 * 中文说明：按 Codex 插件的预览口径规整历史摘要文本，保留完整内容供搜索使用。
 */
function normalizeHistoryPreviewText(value: unknown): string {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text;
}

/**
 * 仅为 Codex 现代 session_meta 暴露主代理/子代理关系；其它 Provider 保持无关系字段。
 */
function extractHistoryCodexRelationship(providerId: ProviderId, parsed: unknown): CodexSessionRelationship | undefined {
  if (providerId !== 'codex') return undefined;
  const relationship = extractCodexSessionRelationship(parsed);
  return relationship.kind === 'unknown' ? undefined : relationship;
}

/**
 * 中文说明：识别 Codex 自动注入的上下文块，避免把 AGENTS/环境信息误当成会话标题。
 */
function isSyntheticCodexContextText(value: string): boolean {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^#\s*AGENTS\.md instructions\b/i.test(text)) return true;
  if (/^<environment_context>/i.test(text)) return true;
  if (/^<turn_aborted>/i.test(text)) return true;
  if (/^Another language model started to solve this problem\b/i.test(text)) return true;
  if (/^#\s*Files mentioned by the user:/i.test(text) && !/^##\s*My request for Codex:?\s*$/im.test(text)) return true;
  return false;
}

/**
 * 中文说明：从 Codex “Files mentioned” 模板中提取真正的用户请求段。
 */
function extractCodexRequestText(value: string): string {
  const raw = String(value || '').replace(/\r\n/g, '\n');
  const filtered = filterCodexHistoryPreviewText(raw);
  if (!filtered || isSyntheticCodexContextText(filtered)) return '';
  return normalizeHistoryPreviewText(filtered);
}

/**
 * 中文说明：从 JSONL 记录中提取 Codex 服务端生成的线程名。
 */
function extractThreadNameFromRecord(obj: any): string {
  try {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.type !== 'event_msg') return '';
    const payload = obj.payload;
    if (!payload || payload.type !== 'thread_name_updated') return '';
    return normalizeHistoryPreviewText(payload.thread_name);
  } catch {
    return '';
  }
}

/**
 * 中文说明：从新旧格式消息记录中提取角色与纯文本内容。
 */
function extractMessageTextFromRecord(obj: any): { role: string; text: string } | null {
  try {
    if (!obj || typeof obj !== 'object') return null;
    const recordType = String(obj.type || obj.record_type || '').toLowerCase();
    const src = recordType === 'response_item' && obj.payload?.type === 'message'
      ? obj.payload
      : (recordType === 'message' ? obj : null);
    if (!src) return null;
    const role = String(src.role || src.actor || src.from || '').toLowerCase();
    let text = '';
    if (Array.isArray(src.content)) {
      for (const c of src.content) {
        if (!c) continue;
        const s = c.text ?? c.input_text ?? c.output_text ?? c.code ?? '';
        if (typeof s === 'string' && s.trim()) {
          text = s;
          break;
        }
      }
    } else if (typeof src.content === 'string') {
      text = src.content;
    } else if (typeof src.input_text === 'string') {
      text = src.input_text;
    }
    if (!text.trim()) return null;
    return { role, text };
  } catch {
    return null;
  }
}

/**
 * 中文说明：解析历史文件前缀中的线程名、用户请求和助手首段文本。
 */
function extractTitleFromPrefix(prefix: string): PrefixTitleParts {
  const out: PrefixTitleParts = {};
  try {
    const lines = String(prefix || '').split(/\r?\n/).filter(Boolean).slice(0, 200);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const threadName = extractThreadNameFromRecord(obj);
        if (threadName && !out.threadName) out.threadName = threadName;
        const msg = extractMessageTextFromRecord(obj);
        if (msg) {
          const cand = msg.role === 'user'
            ? extractCodexRequestText(msg.text)
            : normalizeHistoryPreviewText(msg.text);
          if (!cand || looksNumericOnly(cand)) continue;
          if (msg.role === 'user' && !out.user) out.user = cand;
          else if (!out.assistant) out.assistant = cand;
        }
        if (out.threadName && out.user && out.assistant) break;
      } catch { continue; }
    }
  } catch {}
  return out;
}

/**
 * 中文说明：从 JSON 字符串片段中解码单个字段值。
 */
function decodeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/**
 * 中文说明：在有限字节范围内流式查找 Codex 线程名，避免解析包含大图片的整行 JSON。
 */
async function scanThreadNameFromFile(filePath: string, maxBytes = SUMMARY_THREAD_NAME_SCAN_BYTES): Promise<string> {
  return await new Promise<string>((resolve) => {
    try {
      const marker = '"thread_name_updated"';
      const rs = fs.createReadStream(filePath, { encoding: 'utf8', start: 0, end: Math.max(0, maxBytes - 1), highWaterMark: 64 * 1024 });
      let carry = '';
      let eventBuffer = '';
      let markerSeen = false;
      let done = false;
      const finish = (value: string): void => {
        if (done) return;
        done = true;
        try { rs.close(); } catch {}
        resolve(normalizeHistoryPreviewText(value));
      };
      const tryExtract = (): void => {
        if (!markerSeen) return;
        const m = eventBuffer.match(/"thread_name"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (m && typeof m[1] === 'string') {
          finish(decodeJsonStringFragment(m[1]));
          return;
        }
        if (eventBuffer.length > 8192) finish('');
      };
      rs.on('data', (chunk) => {
        if (done) return;
        const text = String(chunk || '');
        if (markerSeen) {
          eventBuffer += text;
          tryExtract();
          return;
        }
        const combined = carry + text;
        const idx = combined.indexOf(marker);
        if (idx >= 0) {
          markerSeen = true;
          eventBuffer = combined.slice(idx);
          tryExtract();
          return;
        }
        carry = combined.slice(Math.max(0, combined.length - marker.length + 1));
      });
      rs.on('end', () => finish(''));
      rs.on('error', () => finish(''));
    } catch {
      resolve('');
    }
  });
}

/**
 * 中文说明：依据插件策略生成历史摘要文本：线程名优先，其次干净用户请求，再回退显式标题/助手文本。
 */
function deriveHistorySummaryText(
  parsed: any,
  prefix: string,
  filePath: string,
  fallbackId: string,
  opts?: { threadName?: string; prefixParts?: PrefixTitleParts }
): { title: string; preview?: string } {
  const prefixParts = opts?.prefixParts || extractTitleFromPrefix(prefix);
  const threadName = normalizeHistoryPreviewText(opts?.threadName || prefixParts.threadName || '');
  // Prefer explicit fields
  const pTitle = (parsed && typeof parsed.title === 'string') ? parsed.title : undefined;
  const pPayloadTitle = (parsed && typeof parsed.payload?.title === 'string') ? parsed.payload.title : undefined;
  const explicit = normalizeHistoryPreviewText(pTitle || pPayloadTitle || '');
  const preview = threadName || prefixParts.user || explicit || prefixParts.assistant || '';
  const title = clampTitle(preview);
  if (title && !looksNumericOnly(title)) return { title, preview };
  // Fallback: directory or filename
  try {
    const base = path.basename(filePath).replace(/\.jsonl$/i, '') || fallbackId;
    return { title: `Session ${base}` };
  } catch {
    return { title: `Session ${fallbackId}` };
  }
}

/**
 * 中文说明：生成单个历史文件的列表摘要标题与搜索预览。
 */
async function resolveHistorySummaryText(
  parsed: any,
  prefix: string,
  filePath: string,
  fallbackId: string,
  providerId: ProviderId
): Promise<{ title: string; preview?: string }> {
  const prefixParts = extractTitleFromPrefix(prefix);
  let threadName = prefixParts.threadName || '';
  if (!threadName && providerId === 'codex') {
    threadName = await scanThreadNameFromFile(filePath);
  }
  return deriveHistorySummaryText(parsed, prefix, filePath, fallbackId, { threadName, prefixParts });
}

/**
 * 中文说明：兼容旧调用方，返回单行标题文本。
 */
function deriveTitle(parsed: any, prefix: string, filePath: string, fallbackId: string): string {
  return deriveHistorySummaryText(parsed, prefix, filePath, fallbackId).title;
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

// 合并 Codex 轮次与 Claude 上下文解析变更，避免复用任一分支生成的不完整缓存。
const PARSER_VERSION = 'v21';
const CACHE_SCHEMA_VERSION = '2';

/**
 * 中文说明：按路径特征推断历史文件所属 Provider，供回退扫描阶段补齐基础元数据。
 */
function inferHistoryProviderIdFromPath(filePath: string): ProviderId {
  try {
    const fp = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    const base = fp.split('/').pop() || '';
    if (fp.includes('/.grok/sessions/')) return 'grok';
    if (fp.includes('/.claude/')) return 'claude';
    if (fp.includes('/.gemini/')) return 'gemini';
    if (base.endsWith('.ndjson')) return 'claude';
    if (base.startsWith('session-') && (base.endsWith('.jsonl') || base.endsWith('.json'))) return 'gemini';
  } catch {}
  return 'codex';
}

/**
 * 中文说明：规范化 Gemini projectHash，仅接受 32~64 位十六进制。
 */
function normalizeHistoryProjectHash(value: unknown): string | undefined {
  const text = String(value || '').trim().toLowerCase();
  if (/^[a-f0-9]{32,64}$/.test(text)) return text;
  return undefined;
}

/**
 * 中文说明：从已解析的头部对象或文件路径中提取 Gemini projectHash。
 */
function extractHistoryProjectHash(parsed: any, filePath: string): string | undefined {
  const direct = [
    parsed?.projectHash,
    parsed?.project_hash,
    parsed?.payload?.projectHash,
    parsed?.payload?.project_hash,
  ];
  for (const item of direct) {
    const normalized = normalizeHistoryProjectHash(item);
    if (normalized) return normalized;
  }
  return normalizeHistoryProjectHash(extractGeminiProjectHashFromPath(filePath));
}

/**
 * 中文说明：从解析头或文本前缀中收集可能的工作目录候选，供项目归属判断与回退展示复用。
 */
function collectHistoryCwdCandidates(parsed: any, prefix: string): string[] {
  const candidates: string[] = [];
  /**
   * 中文说明：清理单条 cwd 候选，统一去噪并去除尾部分隔符。
   */
  const tidy = (value?: string): string => {
    try {
      if (typeof value !== "string") return "";
      return tidyPathCandidate(value);
    } catch {
      return String(value || '').trim();
    }
  };
  /**
   * 中文说明：向候选列表追加有效 cwd。
   */
  const tryPush = (value?: string): void => {
    const text = tidy(value);
    if (text) candidates.push(text);
  };
  try {
    if (parsed) {
      tryPush(parsed.cwd);
      tryPush(parsed.working_dir);
      tryPush(parsed.projectDir);
      tryPush(parsed.winPath);
      tryPush(parsed.wslPath);
      try {
        if (parsed.type === 'session_meta' && parsed.payload) {
          tryPush(parsed.payload.cwd);
          tryPush(parsed.payload.working_dir);
          tryPush(parsed.payload.projectDir);
          tryPush(parsed.payload.winPath);
          tryPush(parsed.payload.wslPath);
        }
      } catch {}
    }
    const m1 = String(prefix || '').match(/Current\s+working\s+directory:\s*([^\r\n]+)/i);
    if (m1 && m1[1]) tryPush(m1[1]);
    const m2 = String(prefix || '').match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
    if (m2 && m2[1]) tryPush(m2[1]);
  } catch {}
  return candidates;
}

/**
 * 中文说明：根据项目路径收集 Gemini projectHash 候选，供 fallback 归属过滤复用。
 */
function collectHistoryProjectHashNeedles(project: { wslPath?: string; winPath?: string }): Set<string> {
  const needles = new Set<string>();
  /**
   * 中文说明：向候选集合追加单条路径对应的 Gemini projectHash。
   */
  const addPath = (value?: string): void => {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      const hashes = deriveGeminiProjectHashCandidatesFromPath(text);
      for (const hash of hashes) {
        const normalized = normalizeHistoryProjectHash(hash);
        if (normalized) needles.add(normalized);
      }
    } catch {}
  };
  addPath(project.wslPath);
  addPath(project.winPath);
  return needles;
}

type HistoryCachePersisted = {
  schemaVersion: string;
  parserVersion: string;
  entries: HistoryListCacheEntry[];
  savedAt?: number;
};

function getHistoryCachePath(): string {
  const dir = app.getPath('userData');
  return path.join(dir, 'history.index.cache.json');
}

function loadHistoryCache(): HistoryListCacheEntry[] {
  const p = getHistoryCachePath();
  try {
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (Array.isArray(raw)) {
      try { fs.unlinkSync(p); } catch {}
      return [];
    }
    const obj = raw as Partial<HistoryCachePersisted> | null | undefined;
    if (!obj || obj.schemaVersion !== CACHE_SCHEMA_VERSION || obj.parserVersion !== PARSER_VERSION || !Array.isArray(obj.entries)) {
      try { fs.unlinkSync(p); } catch {}
      return [];
    }
    return obj.entries as HistoryListCacheEntry[];
  } catch {
    try { fs.unlinkSync(p); } catch {}
    return [];
  }
}

function saveHistoryCache(list: HistoryListCacheEntry[]) {
  try {
    const capped = list.slice().sort((a, b) => b.savedAt - a.savedAt).slice(0, 30);
    const payload: HistoryCachePersisted = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      entries: capped,
      savedAt: Date.now(),
    };
    fs.writeFileSync(getHistoryCachePath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

export function purgeHistoryCacheIfOutdated(): void {
  const p = getHistoryCachePath();
  try {
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (Array.isArray(raw)) {
      try { fs.unlinkSync(p); } catch {}
      return;
    }
    const obj = raw as Partial<HistoryCachePersisted> | null | undefined;
    const valid = obj && obj.schemaVersion === CACHE_SCHEMA_VERSION && obj.parserVersion === PARSER_VERSION && Array.isArray(obj.entries);
    if (!valid) {
      try { fs.unlinkSync(p); } catch {}
    }
  } catch {
    try { fs.unlinkSync(p); } catch {}
  }
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

/**
 * 中文说明：列出归属于当前项目的 Codex 历史摘要，并生成可搜索的标题/预览。
 */
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
    providerId: ProviderId;
    id: string;
    title: string;
    preview?: string;
    date: number;
    prefix: string;
    rawDate?: string;
    dirKey?: string;
    projectHash?: string;
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
  const cacheKey = (rts: string[], nc: string[]) => `${rts.map((r) => r.toLowerCase()).sort().join('|')}||${nc.sort().join('|')}||${PARSER_VERSION}`;
  const needles = buildNeedles();
  // 将 needles 规范化为统一可对比的 WSL 风格（/mnt/c 或 /home/...），用于前缀对比
  function canon(p?: string): string {
    if (!p) return '';
    return canonicalizeHistoryPathForMatch(p);
  }
  const needlesCanon = Array.from(new Set(needles.map(canon).filter(Boolean)));
  const geminiProjectHashNeedles = collectHistoryProjectHashNeedles(project);
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

  try {
    const sigsNow = await Promise.all(rootsToScan.map((r) => computeRootSig(r)));
    const all = loadHistoryCache();
    const key = cacheKey(rootsToScan, needlesCanon);
    const hit = all.find((e) => e.key === key);
    if (hit && sigsEqual(hit.sigs || [], sigsNow)) {
      logDebug(`cache-hit entries=${hit.list.length}`);
      // Prune entries that no longer exist to avoid stale "ghost" sessions
      const pruned = selectCurrentHistorySummaries(hit.list.filter((e) => {
        try { return fs.existsSync(e.filePath); } catch { return false; }
      }));
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
        return tidyPathCandidate(String(s));
      } catch { return String(s || '').trim(); }
    };
    const push = (v?: string) => { const t = norm(v); if (t) out.push(t); };
    const pw = tidyPathCandidate(projectWslPath || "").split("\\").join("/");
    const pm = tidyPathCandidate(projectWinPath || "");
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
        const w = toWslLikePathKey(pm);
        if (w) push(w);
      }
    } catch {}
    return Array.from(new Set(out.filter(Boolean)));
  }

  async function fileContainsAny(fp: string, needles: string[], maxBytes = SUMMARY_PREFIX_BYTES, cachedLower?: string): Promise<boolean> {
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
          if (typeof v !== "string") return "";
          return tidyPathCandidate(v);
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
        const w = toWslLikePathKey(p);
        if (w) return w;
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
            let preview: string | undefined = undefined;
            let providerId: ProviderId = inferHistoryProviderIdFromPath(fp);
            let dirKey: string | undefined = undefined;
            let projectHash: string | undefined = undefined;
            let resumeMode: 'modern' | 'legacy' | 'unknown' = 'unknown';
            let resumeId: string | undefined = undefined;
            let runtimeShell: RuntimeShell = 'unknown';
            if (cached) {
              const trimmed = trimPrefixForCache(cached.prefix || '');
              if (trimmed !== (cached.prefix || '')) {
                cached = { ...cached, prefix: trimmed };
                summaryCache.set(fp, cached);
                shrinkSummaryCache(summaryCache);
              }
              providerId = cached.providerId || providerId;
              id = cached.id;
              title = cached.title || title;
              preview = cached.preview;
              timestamp = cached.date;
              prefix = trimmed;
              rawDate = cached.rawDate;
              dirKey = cached.dirKey;
              projectHash = cached.projectHash;
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
              const nextProjectHash = extractHistoryProjectHash(parsed, fp) || projectHash;
              if (nextProjectHash !== projectHash) changed = true;
              projectHash = nextProjectHash;
              const nextDirKey = Array.from(new Set(collectHistoryCwdCandidates(parsed, prefix).map(canon).filter(Boolean)))[0] || dirKey;
              if (nextDirKey !== dirKey) changed = true;
              dirKey = nextDirKey;
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
              if (!preview) {
                const summaryText = await resolveHistorySummaryText(parsed, prefix, fp, id, providerId);
                if (summaryText.title && summaryText.title !== title) {
                  title = summaryText.title;
                  changed = true;
                }
                if (summaryText.preview !== preview) {
                  preview = summaryText.preview;
                  changed = true;
                }
              }
              if (stat && changed) {
                const entry: SumCache = {
                  ...cached,
                  providerId,
                  title,
                  preview,
                  prefix,
                  rawDate,
                  dirKey,
                  projectHash,
                  resumeMode,
                  resumeId: resumeId || cached.resumeId || cached.id,
                  runtimeShell,
                };
                summaryCache.set(fp, entry);
              }
            } else {
              // 读取文件前缀，尽量只解析首段，减少 IO
              prefix = await readPrefixChunk(fp, SUMMARY_PREFIX_BYTES);
              prefix = trimPrefixForCache(prefix);
              firstLine = (prefix.split(/\r?\n/).find(Boolean) || '').trim();
              try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
              // 兼容新旧头格式：
              //  - 旧：首行为 { id, timestamp, instructions, git }
              //  - 新：首行为 { timestamp, type: 'session_meta', payload: { id, timestamp, cwd, instructions, git } }
              id = parsed?.id || (parsed?.payload?.id) || id;
              const info = detectResumeInfo(parsed);
              resumeMode = info.mode;
              if (info.id) resumeId = info.id;
              projectHash = extractHistoryProjectHash(parsed, fp);
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
              if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
              dirKey = Array.from(new Set(collectHistoryCwdCandidates(parsed, prefix).map(canon).filter(Boolean)))[0];
              const summaryText = await resolveHistorySummaryText(parsed, prefix, fp, id, providerId);
              title = summaryText.title || titleFromFilename(fp);
              preview = summaryText.preview;
              // 写入缓存
              if (stat) {
                const entry: SumCache = {
                  mtimeMs: stat.mtimeMs,
                  size: stat.size,
                  providerId,
                  id,
                  title,
                  preview,
                  date: timestamp,
                  prefix,
                  rawDate,
                  dirKey,
                  projectHash,
                  resumeMode,
                  resumeId: resumeId || id,
                  runtimeShell,
                };
                summaryCache.set(fp, entry);
                shrinkSummaryCache(summaryCache);
              }
            }
            if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
            let cCanon = dirKey ? [dirKey] : Array.from(new Set(collectHistoryCwdCandidates(parsed, prefix).map(canon).filter(Boolean)));
            if (!dirKey && cCanon.length > 0) dirKey = cCanon[0];
            if (!projectHash) projectHash = extractHistoryProjectHash(parsed, fp);
            // 严格按项目归属过滤：优先从元信息/前缀中提取 cwd，再与 needles 前缀匹配；否则回退到全文前缀搜索
            let belongs = true;
            if (needlesCanon.length > 0) {
              // 路径边界匹配：仅当候选 cwd 在项目路径之内（含相等）时命中
              if (cCanon.length > 0) {
                belongs = cCanon.some((c) => needlesCanon.some((n) => pathMatchesDirKeyScope(c, n)));
                logDebug(`belongs[meta] file=${fp} cCanon=${JSON.stringify(cCanon)} match=${belongs}`);
              } else {
                // 先查找前缀中是否包含项目路径子串
                let hit = await fileContainsAny(fp, needles, SUMMARY_PREFIX_BYTES, (prefix || '').toLowerCase());
                if (!hit) {
                  // 兜底：流式扫描更大范围，提取 <cwd> / CWD 行后再做前缀匹配
                  try {
                    const cwdFromFile = await extractCwdFromFile(fp, { maxScanBytes: 2 * 1024 * 1024 });
                    if (cwdFromFile) {
                      const cc = canon(cwdFromFile);
                      if (cc) {
                        dirKey = dirKey || cc;
                        cCanon = cCanon.includes(cc) ? cCanon : [...cCanon, cc];
                        hit = needlesCanon.some((n) => pathMatchesDirKeyScope(cc, n));
                      }
                      logDebug(`fallback-cwd file=${fp} cwd=${cwdFromFile} cc=${cc} match=${hit}`);
                    } else {
                      logDebug(`fallback-cwd-empty file=${fp}`);
                    }
                  } catch {}
                }
                belongs = !!hit;
                logDebug(`belongs[prefix/fallback] file=${fp} match=${belongs}`);
              }
              if (!belongs && providerId === 'gemini' && geminiProjectHashNeedles.size > 0) {
                const historyHash = normalizeHistoryProjectHash(projectHash || extractGeminiProjectHashFromPath(fp));
                if (historyHash && geminiProjectHashNeedles.has(historyHash)) {
                  belongs = true;
                  logDebug(`belongs[hash] file=${fp} projectHash=${historyHash} match=true`);
                }
              }
            }
            // 构造基础条目（用于回退展示）
            if (!resumeId) resumeId = id;
            const basic: HistorySummary = {
              providerId,
              id,
              title,
              date: (stat?.mtimeMs || 0),
              filePath: fp,
              rawDate,
              preview,
              dirKey,
              projectHash,
              resumeMode,
              resumeId,
              runtimeShell,
              codexRelationship: extractHistoryCodexRelationship(providerId, parsed),
            };
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
  const finalList = selectCurrentHistorySummaries(summaries);
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

/**
 * 中文说明：同时返回当前项目历史与同根目录下的全部历史摘要。
 */
export async function listHistorySplit(project: { wslPath?: string; winPath?: string }, opts?: { historyRoot?: string; limit?: number; offset?: number }): Promise<{ belongs: HistorySummary[]; all: HistorySummary[] }> {
  const belongs = await listHistory(project, opts);
  const rootOriginal = opts?.historyRoot || defaultHistoryRoot();
  const rootsToScan: string[] = await computeHistoryRoots(rootOriginal);
  const canon = (value?: string): string => {
    if (!value) return '';
    return canonicalizeHistoryPathForMatch(value);
  };
  type SumCache = {
    mtimeMs: number;
    size: number;
    providerId: ProviderId;
    id: string;
    title: string;
    preview?: string;
    date: number;
    prefix: string;
    rawDate?: string;
    dirKey?: string;
    projectHash?: string;
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
              let preview: string | undefined = undefined;
              let providerId: ProviderId = inferHistoryProviderIdFromPath(fp);
              let dirKey: string | undefined = undefined;
              let projectHash: string | undefined = undefined;
              let resumeMode: 'modern' | 'legacy' | 'unknown' = 'unknown';
              let resumeId: string | undefined = undefined;
              let runtimeShell: RuntimeShell = 'unknown';
              if (cached) {
                const trimmed = trimPrefixForCache(cached.prefix || '');
                if (trimmed !== (cached.prefix || '')) {
                  cached = { ...cached, prefix: trimmed };
                  summaryCache.set(fp, cached);
                  shrinkSummaryCache(summaryCache);
                }
                providerId = cached.providerId || providerId;
                id = cached.id;
                title = cached.title || title;
                preview = cached.preview;
                timestamp = cached.date;
                prefix = trimmed;
                rawDate = cached.rawDate;
                dirKey = cached.dirKey;
                projectHash = cached.projectHash;
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
                const nextProjectHash = extractHistoryProjectHash(parsed, fp) || projectHash;
                if (nextProjectHash !== projectHash) changed = true;
                projectHash = nextProjectHash;
                const nextDirKey = Array.from(new Set(collectHistoryCwdCandidates(parsed, prefix).map(canon).filter(Boolean)))[0] || dirKey;
                if (nextDirKey !== dirKey) changed = true;
                dirKey = nextDirKey;
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
                if (!preview) {
                  const summaryText = await resolveHistorySummaryText(parsed, prefix, fp, id, providerId);
                  if (summaryText.title && summaryText.title !== title) {
                    title = summaryText.title;
                    changed = true;
                  }
                  if (summaryText.preview !== preview) {
                    preview = summaryText.preview;
                    changed = true;
                  }
                }
                if (stat && changed) {
                  const entry: SumCache = {
                    ...cached,
                    providerId,
                    title,
                    preview,
                    prefix,
                    rawDate,
                    dirKey,
                    projectHash,
                    resumeMode,
                    resumeId: resumeId || cached.resumeId || cached.id,
                    runtimeShell,
                  };
                  summaryCache.set(fp, entry);
                }
              } else {
                prefix = await readPrefixChunk(fp, SUMMARY_PREFIX_BYTES);
                prefix = trimPrefixForCache(prefix);
                firstLine = (prefix.split(/\r?\n/).find(Boolean) || '').trim();
                try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
                id = parsed?.id || (parsed?.payload?.id) || id;
                const info = detectResumeInfo(parsed);
                resumeMode = info.mode;
                if (info.id) resumeId = info.id;
                projectHash = extractHistoryProjectHash(parsed, fp);
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
                if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
                dirKey = Array.from(new Set(collectHistoryCwdCandidates(parsed, prefix).map(canon).filter(Boolean)))[0];
                const summaryText = await resolveHistorySummaryText(parsed, prefix, fp, id, providerId);
                title = summaryText.title || titleFromFilename(fp);
                preview = summaryText.preview;
                if (stat) {
                  const entry: SumCache = {
                    mtimeMs: stat.mtimeMs,
                    size: stat.size,
                    providerId,
                    id,
                    title,
                    preview,
                    date: timestamp,
                    prefix,
                    rawDate,
                    dirKey,
                    projectHash,
                    resumeMode,
                    resumeId: resumeId || id,
                    runtimeShell,
                  };
                  summaryCache.set(fp, entry);
                  shrinkSummaryCache(summaryCache);
                }
              }
              if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
              if (!dirKey) dirKey = Array.from(new Set(collectHistoryCwdCandidates(parsed, prefix).map(canon).filter(Boolean)))[0];
              if (!projectHash) projectHash = extractHistoryProjectHash(parsed, fp);
              if (!resumeId) resumeId = id;
              all.push({
                providerId,
                id,
                title,
                date: (stat?.mtimeMs || 0),
                filePath: fp,
                rawDate,
                preview,
                dirKey,
                projectHash,
                resumeMode,
                resumeId,
                runtimeShell,
                codexRelationship: extractHistoryCodexRelationship(providerId, parsed),
              });
            } catch {}
          }
        }
      }
    }
  }
  const sortDesc = (a: HistorySummary, b: HistorySummary) => b.date - a.date;
  return { belongs: belongs.slice().sort(sortDesc), all: selectCurrentHistorySummaries(all) };
}

const MAX_CODEX_APPLY_PATCH_HISTORY_BYTES = 16 * 1024 * 1024;

type CodexFileChangeValue = {
  type?: unknown;
  unified_diff?: unknown;
  content?: unknown;
  move_path?: unknown;
};

type CodexFileChangeOperation = 'add' | 'update' | 'delete' | 'move';

/**
 * 规范化 FileChange 中的文件路径，统一使用正斜杠以便生成跨平台统一差异。
 */
function normalizeCodexFileChangePath(value: unknown): string {
  let text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = String(JSON.parse(text) || '').trim(); } catch { text = text.slice(1, -1); }
  }
  return text.replace(/\\/g, '/').replace(/[\r\n]+/g, '');
}

/**
 * 规范化 Codex item 记录的工作目录，兼容 file URI、Windows、UNC 与 WSL 路径。
 */
function normalizeCodexFileChangeCwd(value: unknown): string {
  let text = String(value || '').trim().replace(/[\r\n]+/g, '');
  if (!text) return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = String(JSON.parse(text) || '').trim(); } catch { text = text.slice(1, -1); }
  }
  if (/^file:/i.test(text)) {
    try {
      const fileUrl = new URL(text);
      if (fileUrl.protocol === 'file:') {
        const decodedPath = decodeURIComponent(fileUrl.pathname);
        text = fileUrl.hostname && fileUrl.hostname.toLowerCase() !== 'localhost'
          ? `//${fileUrl.hostname}${decodedPath}`
          : decodedPath;
      }
    } catch {}
  }
  if (/^\/[a-z]:[\\/]/i.test(text)) text = text.slice(1);
  if (/^[a-z]:[\\/]/i.test(text) || text.startsWith('//') || text.startsWith('\\\\'))
    return text.replace(/[\\/]+/g, '\\');
  return text.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * 生成插件式 FileChange 合并键：只有同一工作目录下同一路径的普通更新才允许合并。
 */
function buildCodexFileChangeLocationKey(cwd: string, filePath: string): string {
  const normalizedCwd = normalizeCodexFileChangeCwd(cwd).replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedPath = normalizeCodexFileChangePath(filePath).replace(/\/$/, '');
  const windowsLike = /^[a-z]:\//i.test(normalizedCwd)
    || /^[a-z]:\//i.test(normalizedPath)
    || normalizedCwd.startsWith('//')
    || normalizedPath.startsWith('//');
  const cwdKey = windowsLike ? normalizedCwd.toLowerCase() : normalizedCwd;
  const pathKey = windowsLike ? normalizedPath.toLowerCase() : normalizedPath;
  return `${cwdKey}\0${pathKey}`;
}

/**
 * 从文件完整内容生成新增或删除文件的统一差异主体。
 */
function buildCodexWholeFileDiffBody(content: unknown, operation: 'add' | 'delete'): string {
  const normalized = String(content ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hasTrailingNewline) lines.pop();
  const count = lines.length;
  if (operation === 'add') {
    const hunk = `@@ -0,0 +1,${count} @@`;
    return [hunk, ...lines.map((line) => `+${line}`), ...(hasTrailingNewline ? [] : ['\\ No newline at end of file'])].join('\n');
  }
  const hunk = `@@ -1,${count} +0,0 @@`;
  return [hunk, ...lines.map((line) => `-${line}`), ...(hasTrailingNewline ? [] : ['\\ No newline at end of file'])].join('\n');
}

/**
 * 把一条 Codex FileChange 转换为带文件头的统一差异文本。
 */
function buildCodexFileChangeUnifiedDiff(filePath: string, change: CodexFileChangeValue): string {
  const sourcePath = normalizeCodexFileChangePath(filePath);
  if (!sourcePath) return '';
  const rawType = String(change?.type || 'update').trim().toLowerCase();
  const operation = rawType === 'add' || rawType === 'delete' ? rawType : 'update';
  const targetPath = normalizeCodexFileChangePath(change?.move_path) || sourcePath;
  const headerPath = operation === 'delete' ? sourcePath : targetPath;
  const lines = [`diff --git a/${sourcePath} b/${headerPath}`];

  if (operation === 'add') {
    lines.push('new file mode 100644', '--- /dev/null', `+++ b/${targetPath}`);
    lines.push(buildCodexWholeFileDiffBody(change?.content, 'add'));
  } else if (operation === 'delete') {
    lines.push('deleted file mode 100644', `--- a/${sourcePath}`, '+++ /dev/null');
    lines.push(buildCodexWholeFileDiffBody(change?.content, 'delete'));
  } else {
    if (sourcePath !== targetPath) {
      lines.push(`rename from ${sourcePath}`, `rename to ${targetPath}`);
    }
    lines.push(`--- a/${sourcePath}`, `+++ b/${targetPath}`);
    const fragment = String(change?.unified_diff || '').replace(/\r\n?/g, '\n').trim();
    if (fragment) {
      const fragmentLines = fragment.split('\n');
      const bodyStart = fragmentLines.findIndex((line) => line.startsWith('@@'));
      lines.push(...(bodyStart >= 0 ? fragmentLines.slice(bodyStart) : fragmentLines));
    }
  }
  return lines.join('\n').trim();
}

/**
 * 合并同一工作目录与路径下的普通 FileChange 更新，保留首段文件头并追加后续 hunk。
 */
function mergeCodexFileChangeUpdates(parts: string[]): string {
  const normalized = parts.map((part) => String(part || '').replace(/\r\n?/g, '\n').trim()).filter(Boolean);
  if (normalized.length <= 1) return normalized[0] || '';
  const firstLines = normalized[0].split('\n');
  const merged = [...firstLines];
  for (const part of normalized.slice(1)) {
    const partLines = part.split('\n');
    const hunkIndex = partLines.findIndex((line) => line.startsWith('@@'));
    if (hunkIndex >= 0) merged.push(...partLines.slice(hunkIndex));
    else merged.push(...partLines);
  }
  return merged.join('\n').trim();
}

/**
 * 提取一个 FileChange item，并按规范化完整路径稳定排序以对齐 Codex 插件服务端顺序。
 */
function extractCodexFileChangeSegments(item: any): Array<{ path: string; type: CodexFileChangeOperation; text: string }> {
  const changes = item?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const entries = Object.entries(changes as Record<string, CodexFileChangeValue>)
    .map(([rawPath, rawChange], index) => {
      const normalizedPath = normalizeCodexFileChangePath(rawPath);
      const sortKey = /^[a-z]:\//i.test(normalizedPath) || normalizedPath.startsWith('//')
        ? normalizedPath.toLowerCase()
        : normalizedPath;
      return { rawPath, rawChange, normalizedPath, sortKey, index };
    })
    .sort((left, right) => {
      if (left.sortKey < right.sortKey) return -1;
      if (left.sortKey > right.sortKey) return 1;
      return left.index - right.index;
    });
  const segments: Array<{ path: string; type: CodexFileChangeOperation; text: string }> = [];
  for (const { rawPath, rawChange, normalizedPath } of entries) {
    const change = (rawChange && typeof rawChange === 'object' ? rawChange : {}) as CodexFileChangeValue;
    const rawType = String(change.type || 'update').trim().toLowerCase();
    const movePath = normalizeCodexFileChangePath(change.move_path);
    const type: CodexFileChangeOperation = movePath && movePath !== normalizedPath
      ? 'move'
      : (rawType === 'add' || rawType === 'delete' ? rawType : 'update');
    const text = buildCodexFileChangeUnifiedDiff(rawPath, change);
    if (text) segments.push({ path: normalizedPath, type, text });
  }
  return segments;
}

/**
 * 解码工具调用源码中的单个 JavaScript 字符串字面量，不执行任何会话内代码。
 */
function decodeJavaScriptStringLiteral(source: string, literalStart: number): { value: string; end: number } | null {
  const quote = source[literalStart];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';

  for (let index = literalStart + 1; index < source.length; index += 1) {
    const current = source[index];
    if (current === quote) return { value, end: index + 1 };
    if (current !== '\\') {
      value += current;
      continue;
    }

    index += 1;
    if (index >= source.length) return null;
    const escaped = source[index];
    if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === 'b') value += '\b';
    else if (escaped === 'f') value += '\f';
    else if (escaped === 'v') value += '\v';
    else if (escaped === '0') value += '\0';
    else if (escaped === '\n') continue;
    else if (escaped === '\r') {
      if (source[index + 1] === '\n') index += 1;
    } else if (escaped === 'x') {
      const hex = source.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
    } else if (escaped === 'u') {
      const hex = source.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else {
      value += escaped;
    }
  }
  return null;
}

/**
 * 从一段已解码文本中提取完整的 apply_patch 块，并自动去重。
 */
function collectApplyPatchBlocks(text: string, target: string[], seen: Set<string>): void {
  const matcher = /\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(String(text || ''))) !== null) {
    const block = String(match[0] || '').trim();
    if (!block || seen.has(block) || Buffer.byteLength(block, 'utf8') > MAX_CODEX_APPLY_PATCH_HISTORY_BYTES) continue;
    seen.add(block);
    target.push(block);
  }
}

/**
 * 从 Codex 工具调用参数中安全提取 apply_patch 内容，兼容直接调用和 exec 中的字符串变量写法。
 */
function extractCodexApplyPatchBlocks(toolName: unknown, callArguments: unknown): string[] {
  const normalizedToolName = String(toolName || '').trim().toLowerCase();
  const sources: string[] = [];

  /**
   * 深度收集工具参数中的字符串值，避免依赖某一版固定参数结构。
   */
  function visit(value: unknown): void {
    if (typeof value === 'string') {
      sources.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  }

  visit(callArguments);
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source.includes('*** Begin Patch')) continue;
    const isDirectApplyPatch = normalizedToolName.includes('apply_patch');
    const containsApplyPatchCall = /(?:tools|functions)\.apply_patch\s*\(/.test(source);
    if (!isDirectApplyPatch && !containsApplyPatchCall) continue;

    if (isDirectApplyPatch) collectApplyPatchBlocks(source, blocks, seen);
    let markerIndex = source.indexOf('*** Begin Patch');
    while (markerIndex >= 0) {
      const literalStart = markerIndex - 1;
      const decoded = decodeJavaScriptStringLiteral(source, literalStart);
      if (decoded) collectApplyPatchBlocks(decoded.value, blocks, seen);
      markerIndex = source.indexOf('*** Begin Patch', markerIndex + 1);
    }
  }
  return blocks;
}

/**
 * 优先使用用户轮次 ID；内部模型请求 ID 仅供没有轮次事件的旧日志回退。
 */
function resolveCodexTurnId(record: any, source: any, activeTurnId = ''): string {
  const candidates = [
    source?.turn_id,
    source?.turnId,
    record?.turn_id,
    record?.turnId,
    record?.payload?.turn_id,
    record?.payload?.turnId,
    activeTurnId,
    source?.internal_chat_message_metadata_passthrough?.turn_id,
    record?.payload?.internal_chat_message_metadata_passthrough?.turn_id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return '';
}

export async function readHistoryFile(filePath: string, opts?: { chunkSize?: number; maxLines?: number }): Promise<{ id: string; title: string; date: number; messages: Message[]; skippedLines: number }> {
  // 简单缓存：基于文件 mtimeMs + size，避免重复解析未变更文件。
  // 关键点：缓存需要感知“是否完整解析”，避免较小 maxLines 的截断结果污染后续完整详情读取。
  type CacheVal = {
    parserVersion: string;
    mtimeMs: number;
    size: number;
    complete: boolean;
    maxLines: number;
    result: { id: string; title: string; date: number; messages: Message[]; skippedLines: number };
  };
  const g: any = global as any;
  if (!g.__historyCache) g.__historyCache = new Map<string, CacheVal>();
  const cache: Map<string, CacheVal> = g.__historyCache;

  const chunk = opts?.chunkSize || 1024 * 1024; // 1MB
  /**
   * 中文说明：规范化读取上限。
   * - 未传时沿用旧默认值 5000 行，保护摘要/预览等轻量调用；
   * - 传入 `<= 0` 时表示不限行数，用于历史详情全量读取；
   * - 其它显式值仍保留保护上限，避免误传极端数字。
   */
  const maxLines = (() => {
    if (typeof opts?.maxLines !== 'number') return 5000;
    if (!Number.isFinite(opts.maxLines) || opts.maxLines <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.min(100000, Math.floor(opts.maxLines)));
  })();
  const messages: Message[] = [];
  let skipped = 0;
  let id = path.basename(filePath).replace(/\.jsonl$/, '');
  let title = id;
  let date = 0;
  // 说明类去重：会话头 instructions 与用户 <user_instructions> 可能内容相同
  const __seenInstructions = new Set<string>();
  const __normInstr = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const recentImagePathCandidates: string[] = [];
  const imagePathCandidatesByCallId = new Map<string, string[]>();
  const turnDiffMessagesByKey = new Map<string, Message>();
  const turnDiffSourceByKey = new Map<string, 'apply_patch' | 'file_change' | 'turn_diff'>();
  // 无同轮正文时按最后一次替换的位置排序，同一位置保留更新先后。
  const turnDiffPositionByMessage = new Map<Message, number>();
  type FileChangeSegment = { path: string; type: CodexFileChangeOperation; text: string };
  type FileChangeTurnState = {
    segments: FileChangeSegment[];
    updateByLocation: Map<string, { index: number; parts: string[] }>;
    cardCwd: string;
  };
  const fileChangeStateByKey = new Map<string, FileChangeTurnState>();
  const commandCwdByTurn = new Map<string, string>();
  let anonymousTurnDiffIndex = 0;
  let historyCwd = '';
  let activeTurnId = '';
  let activeTurnCompleted = false;
  let currentMessageMetadata: Pick<Message, 'phase' | 'timestamp'> = {};
  let currentCompactionOutput = false;
  const turnStartedAt = new Map<string, number>();
  const turnMessagesById = new Map<string, Message[]>();

  /**
   * 解析完成后一次整理轮次改动卡片，避免每条消息都扫描整个历史数组。
   */
  function finalizeTurnDiffMessageOrder(): Message[] {
    const cards = new Set(turnDiffPositionByMessage.keys());
    if (cards.size === 0) return messages;
    const lastMessageByTurn = new Map<string, Message>();
    for (const message of messages) {
      if (message.turnId && !cards.has(message)) lastMessageByTurn.set(message.turnId, message);
    }
    const cardsAfterMessage = new Map<Message, Message>();
    const cardsAtBoundary = new Map<number, Message[]>();
    for (const [card, position] of turnDiffPositionByMessage) {
      const anchor = lastMessageByTurn.get(card.turnId!);
      if (anchor) cardsAfterMessage.set(anchor, card);
      else {
        const siblings = cardsAtBoundary.get(position) || [];
        siblings.push(card);
        cardsAtBoundary.set(position, siblings);
      }
    }
    const ordered: Message[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!cards.has(message)) ordered.push(message);
      const card = cardsAfterMessage.get(message);
      if (card) ordered.push(card);
      for (const unanchoredCard of cardsAtBoundary.get(index + 1) || []) ordered.push(unanchoredCard);
    }
    return ordered;
  }

  /**
   * 为消息附加稳定轮次标识，避免把 undefined 属性写入历史缓存。
   */
  function withTurnId(message: Message, turnId?: string): Message {
    const normalizedTurnId = String(turnId || '').trim();
    const result = { ...message, ...currentMessageMetadata, ...(normalizedTurnId ? { turnId: normalizedTurnId } : {}) };
    if (currentCompactionOutput) {
      result.role = 'compaction';
      result.content = result.content.map((item) => ({
        ...item,
        type: 'context_compaction',
        tags: ['context_compaction'],
      }));
    }
    if (normalizedTurnId) {
      const turnMessages = turnMessagesById.get(normalizedTurnId) || [];
      turnMessages.push(result);
      turnMessagesById.set(normalizedTurnId, turnMessages);
    }
    return result;
  }

  /**
   * 新增或合并一条轮次改动消息；标准 turn_diff 到达时会替换同轮的 apply_patch 回退内容。
   */
  function upsertTurnDiffMessage(options: {
    turnId?: string;
    fallbackKey?: string;
    text: string;
    tags: string[];
    replaceExisting?: boolean;
    source?: 'apply_patch' | 'file_change' | 'turn_diff';
    cwd?: string;
    patchable?: boolean;
    appendAlways?: boolean;
  }): void {
    const text = String(options.text || '').trim();
    if (!text) return;
    const turnId = String(options.turnId || '').trim();
    const fallbackKey = String(options.fallbackKey || '').trim();
    const key = turnId
      ? `turn:${turnId}`
      : (fallbackKey ? `fallback:${fallbackKey}` : `anonymous:${anonymousTurnDiffIndex++}`);
    const source = options.source || 'apply_patch';
    const sourceRank = source === 'turn_diff' ? 3 : (source === 'file_change' ? 2 : 1);
    const existing = turnDiffMessagesByKey.get(key);
    if (existing?.content?.[0]) {
      const item = existing.content[0];
      const existingSource = turnDiffSourceByKey.get(key);
      const existingRank = existingSource === 'turn_diff' ? 3 : (existingSource === 'file_change' ? 2 : 1);
      if (existingSource && sourceRank < existingRank) return;
      if (options.replaceExisting) {
        item.text = text;
        item.tags = options.tags;
        item.cwd = String(options.cwd || item.cwd || '').trim() || undefined;
        item.diffSource = source;
        item.patchable = typeof options.patchable === 'boolean' ? options.patchable : source !== 'file_change';
        turnDiffSourceByKey.set(key, source);
        if (turnId) {
          turnDiffPositionByMessage.delete(existing);
          turnDiffPositionByMessage.set(existing, messages.length);
        }
        return;
      }
      if (options.appendAlways || !String(item.text || '').includes(text)) item.text = `${String(item.text || '').trim()}\n${text}`.trim();
      item.tags = Array.from(new Set([...(item.tags || []), ...options.tags]));
      item.cwd = String(options.cwd || item.cwd || '').trim() || undefined;
      item.diffSource = source;
      item.patchable = typeof options.patchable === 'boolean' ? options.patchable : source !== 'file_change';
      turnDiffSourceByKey.set(key, source);
      return;
    }

    const message: Message = withTurnId({
      role: 'change',
      content: [{ type: 'turn_diff', text, tags: options.tags }],
    }, turnId);
    message.content[0].cwd = String(options.cwd || '').trim() || undefined;
    message.content[0].diffSource = source;
    message.content[0].patchable = typeof options.patchable === 'boolean' ? options.patchable : source !== 'file_change';
    turnDiffMessagesByKey.set(key, message);
    turnDiffSourceByKey.set(key, source);
    messages.push(message);
    if (turnId) turnDiffPositionByMessage.set(message, messages.length);
  }

  /**
   * 累积同一轮的 FileChange：普通更新按“工作目录 + 路径”合并，其它操作保持独立差异段。
   */
  function upsertCodexFileChange(item: any, turnId: string, cwd?: string): void {
    const normalizedTurnId = String(turnId || '').trim();
    const fallbackKey = String(item?.id || '').trim();
    const key = normalizedTurnId ? `turn:${normalizedTurnId}` : (fallbackKey ? `fallback:${fallbackKey}` : `anonymous:${anonymousTurnDiffIndex++}`);
    const normalizedCwd = normalizeCodexFileChangeCwd(cwd || historyCwd);
    const state = fileChangeStateByKey.get(key) || {
      segments: [],
      updateByLocation: new Map<string, { index: number; parts: string[] }>(),
      cardCwd: normalizedCwd,
    };
    if (!state.cardCwd && normalizedCwd) state.cardCwd = normalizedCwd;
    fileChangeStateByKey.set(key, state);
    for (const segment of extractCodexFileChangeSegments(item)) {
      const locationKey = buildCodexFileChangeLocationKey(normalizedCwd, segment.path);
      const activeUpdate = state.updateByLocation.get(locationKey);
      if (segment.type === 'update' && activeUpdate) {
        activeUpdate.parts.push(segment.text);
        state.segments[activeUpdate.index] = {
          ...state.segments[activeUpdate.index],
          text: mergeCodexFileChangeUpdates(activeUpdate.parts),
        };
        continue;
      }
      const index = state.segments.length;
      state.segments.push(segment);
      if (segment.type === 'update') state.updateByLocation.set(locationKey, { index, parts: [segment.text] });
      else state.updateByLocation.delete(locationKey);
    }
    const text = state.segments.map((segment) => segment.text).join('\n').trim();
    if (!text) return;
    upsertTurnDiffMessage({
      turnId: normalizedTurnId,
      fallbackKey: normalizedTurnId ? undefined : fallbackKey,
      text,
      tags: ['event_msg.item_completed.FileChange', 'FileChange', 'turn_diff'],
      replaceExisting: true,
      source: 'file_change',
      cwd: state.cardCwd || normalizeCodexFileChangeCwd(historyCwd) || undefined,
      patchable: false,
    });
  }

  // 读取 stat 并检查缓存
  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (stat) {
    const key = filePath;
    const prev = cache.get(key);
    if (prev && prev.parserVersion === PARSER_VERSION && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size && (prev.complete || prev.maxLines >= maxLines)) {
      return prev.result;
    }
  }

  // 统一的行解析函数，便于 UNC/WSL 与本地读取共享逻辑
  function pretty(v: any): string {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  /**
   * 中文说明：记录最近在历史文本中出现的图片路径，供后续图片结果块做就近关联。
   */
  function rememberImagePathsFromText(text?: string): string[] {
    const extracted = extractImagePathCandidatesFromText(text);
    try {
      for (const candidate of extracted) {
        if (!candidate || recentImagePathCandidates.includes(candidate)) continue;
        recentImagePathCandidates.push(candidate);
        while (recentImagePathCandidates.length > 8) recentImagePathCandidates.shift();
      }
    } catch {}
    return extracted;
  }

  /**
   * 中文说明：返回最近一次出现的图片路径候选。
   */
  function latestImagePathCandidate(): string {
    return recentImagePathCandidates.length > 0 ? String(recentImagePathCandidates[recentImagePathCandidates.length - 1] || '') : '';
  }

  /**
   * 中文说明：把函数调用中的图片路径候选按 `call_id` 绑定，供对应输出块精确回填本地路径。
   * - 优先使用函数参数里直接出现的路径，避免多个 `view_image` 连续调用时都误绑到“最近一张图”；
   * - 同一 `call_id` 仅保留去重后的顺序列表，兼容单次调用携带多张图片的情况。
   */
  function rememberImagePathsForCallId(callId?: string, candidates?: string[]): void {
    const normalizedCallId = String(callId || '').trim();
    if (!normalizedCallId) return;
    const next = Array.isArray(candidates)
      ? candidates.filter((candidate) => String(candidate || '').trim().length > 0)
      : [];
    if (next.length === 0) return;

    const uniqueCandidates = Array.from(new Set(next));
    imagePathCandidatesByCallId.set(normalizedCallId, uniqueCandidates);
  }

  /**
   * 中文说明：为函数输出里的第 N 个图片块选择最合适的本地路径提示。
   * - 先按 `call_id` 命中对应函数调用时记录的路径；
   * - 若该调用只记录到一张路径，则复用于该输出里的所有图片块；
   * - 最后再回退到全局最近图片路径，兼容旧日志或缺失 `call_id` 的场景。
   */
  function resolveImagePathHintForCallOutput(callId: string, imageIndex: number): string {
    const normalizedCallId = String(callId || '').trim();
    const candidates = normalizedCallId ? (imagePathCandidatesByCallId.get(normalizedCallId) || []) : [];
    if (candidates[imageIndex]) return String(candidates[imageIndex] || '');
    if (candidates.length > 0) return String(candidates[candidates.length - 1] || '');
    return latestImagePathCandidate();
  }

  /**
   * 中文说明：从函数调用参数中提取图片路径候选，并兼容 JSON 字符串里的转义反斜杠。
   * - 优先遍历反序列化后的参数对象，拿到真实路径值；
   * - 反序列化失败时退回原始字符串/格式化文本，兼容历史日志里的自由文本参数。
   */
  function extractImagePathCandidatesFromFunctionCallArguments(args: unknown, fallbackText?: string): string[] {
    const out = new Set<string>();

    /**
     * 中文说明：把一段文本里的图片路径候选加入结果集，保持原始顺序并自动去重。
     */
    function rememberCandidatesFromText(text?: string): void {
      for (const candidate of extractImagePathCandidatesFromText(text)) {
        if (!candidate) continue;
        out.add(candidate);
      }
    }

    /**
     * 中文说明：深度遍历函数参数值，收集其中所有字符串型图片路径。
     */
    function visitArgumentValue(value: unknown): void {
      if (typeof value === 'string') {
        rememberCandidatesFromText(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          visitArgumentValue(item);
        }
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const item of Object.values(value as Record<string, unknown>)) {
        visitArgumentValue(item);
      }
    }

    if (typeof args === 'string') {
      let parsed = false;
      try {
        visitArgumentValue(JSON.parse(args));
        parsed = true;
      } catch {}
      if (!parsed || out.size === 0) rememberCandidatesFromText(args);
    } else {
      visitArgumentValue(args);
    }

    if (out.size === 0) rememberCandidatesFromText(fallbackText);
    return Array.from(out);
  }

  /**
   * 中文说明：按既有标签前缀规则拆分文本，并写入统一消息内容数组。
   * - 复用 `extractTaggedPrefix`，保持 `instructions/environment_context` 的展示与筛选语义一致；
   * - 仅在需要补造旧格式 `event_msg.user_message` 时使用，避免扩大既有分支改动面。
   */
  function appendTaggedTextContent(
    contentArr: MessageContent[],
    text: string,
    options?: { itemType?: string; containerTag?: string },
  ): void {
    const source = String(text || '');
    if (!source.trim()) return;

    const itemType = String(options?.itemType || 'text');
    const containerTag = String(options?.containerTag || `message.${itemType.toLowerCase()}`);
    const { rest, picked } = extractTaggedPrefix(source);
    if (picked.length > 0) {
      for (const item of picked) {
        if (String(item.type).toLowerCase() === 'instructions') {
          const key = __normInstr(String(item.text || ''));
          if (key && __seenInstructions.has(key)) continue;
          if (key) __seenInstructions.add(key);
        }
        const innerTag = 'message.' + String(item.type).toLowerCase();
        contentArr.push({ ...item, tags: Array.from(new Set([...(item.tags || []), innerTag, containerTag])) });
      }
      if (rest.trim().length > 0) contentArr.push({ type: itemType, text: rest, tags: [containerTag] });
      return;
    }

    contentArr.push({ type: itemType, text: source, tags: [containerTag] });
  }

  /**
   * 中文说明：从未知值中提取非空字符串数组。
   */
  function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === 'string' && String(item).trim().length > 0)
      .map((item) => String(item).trim());
  }

  /**
   * 中文说明：判断内容块是否为 Codex 图片块。
   */
  function isCodexImageBlockLike(block: any): boolean {
    try {
      if (!block || typeof block !== 'object') return false;
      const type = String(block.type || '').toLowerCase();
      const imageUrl = typeof block.image_url === 'string' ? block.image_url : (typeof block.url === 'string' ? block.url : '');
      return type === 'input_image' || /^data:image\//i.test(imageUrl);
    } catch {
      return false;
    }
  }

  /**
   * 中文说明：判断文本项是否只是 Codex 为图片插入的边界标记。
   */
  function isCodexImageBoundaryText(text?: string): boolean {
    return /^<\/?image>$/i.test(String(text || '').trim());
  }

  /**
   * 中文说明：判断当前内容项是否应作为图片边界噪音跳过。
   */
  function shouldSkipCodexImageBoundaryContentItem(item: any, messageHasImageBlock: boolean): boolean {
    if (!messageHasImageBlock) return false;
    if (typeof item === 'string') return isCodexImageBoundaryText(item);
    if (!item || typeof item !== 'object') return false;
    const type = String(item.type || '').trim().toLowerCase();
    if (type !== 'input_text' && type !== 'text') return false;
    return isCodexImageBoundaryText(item.text);
  }

  /**
   * 中文说明：把 `event_msg.user_message` 恢复为“文本 + 多张图片”内容。
   * - 支持新版 `images/local_images` 数组，也兼容旧版仅在正文里记录图片绝对路径的日志；
   * - 保留原始输入文本，便于搜索与上下文回看；
   * - 为每张图片生成独立图片内容项，解决一条消息多图只挂上一张的问题。
   */
  function buildCodexUserMessageEventContent(payload: any): MessageContent[] | null {
    try {
      if (!payload || typeof payload !== 'object') return null;
      const inlineImages = normalizeStringArray(payload.images);
      const localImages = normalizeStringArray(payload.local_images);
      const messageText = typeof payload.message === 'string' ? payload.message : '';
      const pathCandidates = extractImagePathCandidatesFromText(messageText);
      if (inlineImages.length === 0 && localImages.length === 0 && pathCandidates.length === 0) return null;

      const contentArr: MessageContent[] = [];
      let imageItemCount = 0;
      appendTaggedTextContent(contentArr, messageText, { itemType: 'input_text', containerTag: 'message.input_text' });

      const imageCount = Math.max(inlineImages.length, localImages.length);
      for (let index = 0; index < imageCount; index += 1) {
        const imageData = String(inlineImages[index] || '').trim();
        const imageItem = createHistoryImageContent({
          localPath: localImages[index],
          deferLocalFileCheck: true,
          dataUrl: /^data:image\//i.test(imageData) ? imageData : undefined,
          base64Data: imageData && !/^data:image\//i.test(imageData) ? imageData : undefined,
          tags: ['message.image', 'event_msg.user_message.image'],
        });
        if (imageItem) {
          contentArr.push(imageItem);
          imageItemCount += 1;
        }
      }

      if (imageCount === 0) {
        for (const localPath of pathCandidates) {
          const imageItem = createHistoryImageContent({
            localPath,
            deferLocalFileCheck: true,
            tags: ['message.image', 'event_msg.user_message.image'],
          });
          if (imageItem) {
            contentArr.push(imageItem);
            imageItemCount += 1;
          }
        }
      }

      return imageItemCount > 0 ? contentArr : null;
    } catch {
      return null;
    }
  }

  /**
   * 中文说明：提取消息内容中的可比较正文，用于识别同一轮输入的重复 user 记录。
   * - 仅拼接文本型内容，避免图片项或标签差异干扰判断；
   * - 统一换行与首尾空白，兼容 `response_item.message(user)` 与 `event_msg.user_message` 的并行落盘。
   */
  function buildComparableUserMessageText(content?: MessageContent[] | null): string {
    const parts: string[] = [];
    for (const item of content || []) {
      if (String(item?.type || '').trim().toLowerCase() === 'image') continue;
      const text = String(item?.text || '').replace(/\r\n/g, '\n').trim();
      if (text) parts.push(text);
    }
    return parts.join('\n').trim();
  }

  /**
   * 中文说明：判断消息内容是否只包含子代理通知，避免把通知当成真实用户输入。
   */
  function isSubagentNotificationOnlyContent(contentArr: MessageContent[] | null | undefined): boolean {
    const items = Array.isArray(contentArr) ? contentArr : [];
    if (items.length === 0) return false;
    return items.every((item) => String(item?.type || '').trim().toLowerCase() === 'subagent_notification');
  }

  /**
   * 中文说明：将纯子代理通知的历史角色规整为 notification，避免详情页和锚点逻辑误判为用户输入。
   */
  function normalizeHistoryMessageRoleForContent(role: unknown, contentArr: MessageContent[]): string {
    const rawRole = String(role || '').trim() || 'user';
    if (rawRole.toLowerCase() === 'user' && isSubagentNotificationOnlyContent(contentArr)) return 'notification';
    return rawRole;
  }

  /**
   * 中文说明：将 `event_msg.user_message` 恢复出的图片并入上一条等价 user 消息，避免详情页重复显示同一块输入。
   * - 仅匹配“最后一条消息就是同文本 user”的近邻场景，保持判定简单且不误伤真实重复提问；
   * - 若上一条已存在同签名图片，则仅抑制重复块，不重复附加图片项。
   */
  function mergePathOnlyUserMessageIntoPreviousUserMessage(content?: MessageContent[] | null): boolean {
    const previousMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!previousMessage || String(previousMessage.role || '').trim().toLowerCase() !== 'user') return false;

    const incomingText = buildComparableUserMessageText(content);
    const previousText = buildComparableUserMessageText(previousMessage.content || []);
    if (!incomingText || incomingText !== previousText) return false;

    const existingImageKeys = new Set(
      (previousMessage.content || [])
        .filter((item) => String(item?.type || '').trim().toLowerCase() === 'image')
        .map((item) => [String(item?.localPath || ''), String(item?.src || ''), String(item?.fallbackSrc || ''), String(item?.text || '')].join('\u0000')),
    );
    const nextImages = (content || [])
      .filter((item) => String(item?.type || '').trim().toLowerCase() === 'image')
      .filter((item) => {
        const key = [String(item?.localPath || ''), String(item?.src || ''), String(item?.fallbackSrc || ''), String(item?.text || '')].join('\u0000');
        if (!key || existingImageKeys.has(key)) return false;
        existingImageKeys.add(key);
        return true;
      });
    if (nextImages.length > 0)
      previousMessage.content = [...(previousMessage.content || []), ...nextImages];
    return true;
  }

  /**
   * 中文说明：将 Codex 历史中的图片块转换为统一图片内容项。
   */
  function createCodexImageContent(block: any, localPathHint?: string): MessageContent | null {
    try {
      if (!block || typeof block !== 'object') return null;
      const type = String(block.type || '').toLowerCase();
      const imageUrl = typeof block.image_url === 'string' ? block.image_url : (typeof block.url === 'string' ? block.url : '');
      if (type !== 'input_image' && !/^data:image\//i.test(imageUrl)) return null;
      const localPath = typeof block.local_path === 'string'
        ? block.local_path
        : (typeof block.file_path === 'string'
          ? block.file_path
          : (typeof block.path === 'string' ? block.path : localPathHint));
      return createHistoryImageContent({
        localPath,
        deferLocalFileCheck: true,
        dataUrl: imageUrl,
        mimeType: typeof block.mime_type === 'string' ? block.mime_type : (typeof block.mimeType === 'string' ? block.mimeType : undefined),
      });
    } catch {
      return null;
    }
  }

  /**
   * 中文说明：剥离 `function_call_output` 中已单独抽取的图片块，避免把大段 Base64 再写入文本。
   */
  function stripCodexImageBlocks(output: any): any {
    try {
      if (Array.isArray(output)) {
        const rest = output.filter((item) => !createCodexImageContent(item));
        return rest.length > 0 ? rest : '';
      }
      return output;
    } catch {
      return output;
    }
  }

  function parseLine(line: string, lineIndex: number) {
    if (!line.trim()) return lineIndex;
    try {
      const obj = JSON.parse(line);
      const source = obj.type === 'response_item' && obj.payload ? obj.payload : obj;
      currentMessageMetadata = {
        ...(typeof source.phase === 'string' ? { phase: source.phase } : {}),
        ...(typeof obj.timestamp === 'string' ? { timestamp: obj.timestamp } : {}),
      };
      currentCompactionOutput = obj.metadata?.compaction_output === true;
      const explicitTurnId = resolveCodexTurnId(obj, source);
      const eventType = obj.type === 'event_msg' ? String(obj.payload?.type || '').toLowerCase() : '';
      if ((eventType === 'task_started' || obj.type === 'turn_context') && explicitTurnId) {
        activeTurnId = explicitTurnId;
        activeTurnCompleted = false;
        const timestampMs = Date.parse(String(obj.timestamp || ''));
        if (eventType === 'task_started' && Number.isFinite(timestampMs)) turnStartedAt.set(activeTurnId, timestampMs);
      } else if (activeTurnCompleted && (eventType === 'user_message' || (source.type === 'message' && source.role === 'user'))) {
        // 没有开始事件的旧日志以新的用户输入切断上一轮，避免跨轮合并相同文件。
        activeTurnId = '';
        activeTurnCompleted = false;
      }
      if (lineIndex === 0) {
        // 新版：顶层为 session_meta，真实头部在 payload 中
        if (obj && obj.type === 'session_meta' && obj.payload) {
          historyCwd = normalizeCodexFileChangeCwd(obj.payload.cwd || obj.payload.working_dir);
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
          historyCwd = normalizeCodexFileChangeCwd(obj?.cwd || obj?.working_dir);
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
      const userMessageEventContent = obj.type === 'event_msg' && obj.payload && obj.payload.type === 'user_message'
        ? buildCodexUserMessageEventContent(obj.payload)
        : null;
      const turnDiffEventText = obj.type === 'event_msg' && obj.payload && obj.payload.type === 'turn_diff'
        ? String(obj.payload.unified_diff || '').trim()
        : '';
      const codexTurnId = resolveCodexTurnId(obj, obj?.payload, activeTurnId);
      if (eventType === 'task_complete' || eventType === 'task_completed') {
        const startedAt = turnStartedAt.get(codexTurnId);
        const completedAt = Date.parse(String(obj.timestamp || ''));
        if (startedAt !== undefined && Number.isFinite(completedAt) && completedAt >= startedAt) {
          for (const message of turnMessagesById.get(codexTurnId) || []) message.durationMs = completedAt - startedAt;
        }
        if (codexTurnId === activeTurnId) activeTurnCompleted = true;
      }
      const completedItem = obj.type === 'event_msg'
        && obj.payload
        && obj.payload.type === 'item_completed'
        && obj.payload.item
        ? obj.payload.item
        : null;
      const completedItemType = String(completedItem?.type || '').trim().toLowerCase();
      const fileChangeItem = completedItemType === 'filechange' ? completedItem : null;
      if (completedItemType === 'commandexecution') {
        const commandCwd = normalizeCodexFileChangeCwd(completedItem?.cwd || obj.payload?.cwd);
        if (commandCwd) commandCwdByTurn.set(codexTurnId, commandCwd);
      }
      if (obj.type === 'turn_context' && obj.payload?.cwd && !historyCwd)
        historyCwd = normalizeCodexFileChangeCwd(obj.payload.cwd);

      if (obj.type === 'compacted' || completedItemType === 'contextcompaction') {
        const text = typeof obj.payload?.message === 'string' ? obj.payload.message : pretty(obj.payload || obj);
        messages.push(withTurnId({ role: 'compaction', content: [{ type: 'context_compaction', text, tags: ['context_compaction'] }] }, codexTurnId));
      } else if (obj.type === 'message' || obj.record_type === 'message' || (obj.type === 'response_item' && obj.payload && (obj.payload.type === 'message' || obj.payload.record_type === 'message'))) {
	        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
	        const role = src.role || src.actor || src.from || 'user';
	        const contentArr: MessageContent[] = [];
          const localImages = Array.isArray((src as any).local_images)
            ? (src as any).local_images.filter((item: any) => typeof item === 'string' && String(item).trim().length > 0)
            : [];
          let localImageCursor = 0;
	        // 仅“前缀”匹配提取 <user_instructions>/<permissions instructions>/<environment_context> 等，不做全文搜索（性能考虑）
	        if (Array.isArray(src.content)) {
            const messageHasImageBlock = src.content.some((item: any) => isCodexImageBlockLike(item));
	          for (const c of src.content) {
	            if (!c) continue;
              if (shouldSkipCodexImageBoundaryContentItem(c, messageHasImageBlock)) continue;
              if (typeof c === 'object') {
                const localPathHint = String(localImages[localImageCursor] || latestImagePathCandidate() || '');
                const imageItem = createCodexImageContent(c, localPathHint);
                if (imageItem) {
                  if (localImages[localImageCursor]) localImageCursor += 1;
                  contentArr.push(imageItem);
                  continue;
                }
              }
	            if (c.type && (c.text || c.code || c.payload)) {
              const text = c.text ?? c.code ?? pretty(c.payload ?? '');
              const s = String(text ?? '');
              if (s.trim().length === 0) continue;
              rememberImagePathsFromText(s);
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
              rememberImagePathsFromText(s);
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
            rememberImagePathsFromText(s);
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
              rememberImagePathsFromText(it);
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
        // developer 角色增强：为其内容项补充稳定标签，便于前端在“类型筛选”中单独开关
        try {
          const roleLower = String(role || '').trim().toLowerCase();
          if (roleLower === 'developer') {
            for (const it of contentArr) {
              const prev = Array.isArray(it.tags) ? it.tags : [];
              if (!prev.includes('developer')) it.tags = [...prev, 'developer'];
            }
          }
        } catch {}
        if (contentArr.length > 0) {
          const message = withTurnId({ role: normalizeHistoryMessageRoleForContent(role, contentArr), content: contentArr }, codexTurnId);
          messages.push(message);
        }
      } else if (userMessageEventContent) {
        try {
          rememberImagePathsFromText(typeof obj.payload?.message === 'string' ? obj.payload.message : '');
        } catch {}
        if (!mergePathOnlyUserMessageIntoPreviousUserMessage(userMessageEventContent)) {
          messages.push(withTurnId({ role: 'user', content: userMessageEventContent }, codexTurnId));
        }
      } else if (fileChangeItem) {
        const fileChangeCwd = normalizeCodexFileChangeCwd(
          fileChangeItem.cwd
          || obj.payload?.cwd
          || commandCwdByTurn.get(codexTurnId)
          || historyCwd,
        );
        upsertCodexFileChange(
          fileChangeItem,
          codexTurnId || String(fileChangeItem.turn_id || '').trim(),
          fileChangeCwd,
        );
      } else if (turnDiffEventText) {
        upsertTurnDiffMessage({
          turnId: codexTurnId,
          text: turnDiffEventText,
          tags: ['event_msg.turn_diff', 'turn_diff'],
          replaceExisting: true,
          source: 'turn_diff',
          cwd: historyCwd || undefined,
          patchable: true,
        });
      } else if (
        obj.type === 'function_call'
        || obj.type === 'custom_tool_call'
        || (obj.type === 'response_item' && obj.payload && (obj.payload.type === 'function_call' || obj.payload.type === 'custom_tool_call'))
      ) {
        // 工具/函数调用
        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
        const name = src.name || src.tool || src.function || 'function';
        const callArguments = src.type === 'custom_tool_call' ? src.input : src.arguments;
        const applyPatchBlocks = extractCodexApplyPatchBlocks(name, callArguments);
        if (applyPatchBlocks.length > 0) {
          upsertTurnDiffMessage({
            turnId: resolveCodexTurnId(obj, src, activeTurnId),
            fallbackKey: String((src as any).call_id || ''),
            text: applyPatchBlocks.join('\n'),
            tags: ['custom_tool_call.apply_patch', 'apply_patch', 'turn_diff'],
            source: 'apply_patch',
            cwd: historyCwd || undefined,
            patchable: true,
          });
        }
        let argsPretty = '';
        try {
          if (typeof callArguments === 'string') {
            try { argsPretty = JSON.stringify(JSON.parse(callArguments), null, 2); }
            catch { argsPretty = callArguments; }
          } else if (callArguments) {
            argsPretty = JSON.stringify(callArguments, null, 2);
          }
        } catch {}
        const text = `name: ${name}\n${argsPretty ? 'arguments:\n' + argsPretty : ''}${(src as any).call_id ? `\ncall_id: ${(src as any).call_id}` : ''}`.trim();
        rememberImagePathsFromText(text);
        const imagePathCandidates = extractImagePathCandidatesFromFunctionCallArguments(callArguments, text);
        rememberImagePathsForCallId((src as any).call_id, imagePathCandidates);
        messages.push(withTurnId({ role: 'tool', content: [{ type: 'function_call', text, tags: ['function_call'] }] }, resolveCodexTurnId(obj, src, activeTurnId)));
      } else if (
        obj.type === 'function_call_output'
        || obj.type === 'custom_tool_call_output'
        || (obj.type === 'response_item' && obj.payload && (obj.payload.type === 'function_call_output' || obj.payload.type === 'custom_tool_call_output'))
      ) {
        // 工具输出
        const src: any = (obj.type === 'response_item' && obj.payload) ? obj.payload : obj;
        const contentArr: MessageContent[] = [];
        try {
          const outputItems = Array.isArray(src.output) ? src.output : [];
          const callId = String((src as any).call_id || '');
          let imageIndex = 0;
          for (const item of outputItems) {
            const imageItem = createCodexImageContent(item, resolveImagePathHintForCallOutput(callId, imageIndex));
            if (imageItem) {
              contentArr.push(imageItem);
              imageIndex += 1;
            }
          }
        } catch {}
        let out = '';
        try {
          const sanitizedOutput = stripCodexImageBlocks(src.output);
          if (typeof sanitizedOutput === 'string') {
            // 某些日志将整个对象 JSON 作为字符串包裹
            try { out = JSON.stringify(JSON.parse(sanitizedOutput), null, 2); }
            catch { out = sanitizedOutput; }
          } else if (sanitizedOutput) {
            out = JSON.stringify(sanitizedOutput, null, 2);
          }
        } catch {}
        const meta = (src as any).metadata ? `\nmetadata:\n${pretty((src as any).metadata)}` : '';
        const text = `${out}${meta}`.trim();
        if (text) {
          rememberImagePathsFromText(text);
          contentArr.unshift({ type: 'function_output', text, tags: ['function_output'] });
        }
        if (contentArr.length > 0) {
          const turnId = resolveCodexTurnId(obj, src, activeTurnId);
          messages.push(withTurnId({ role: 'tool', content: contentArr }, turnId));
        }
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
        if (items.length > 0) {
          const turnId = resolveCodexTurnId(obj, src, activeTurnId);
          messages.push(withTurnId({ role: 'reasoning', content: items }, turnId));
        }
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
  const historyStream = stat ? await openCodexHistoryStream(filePath, chunk, { rawBytes: true }) : null;

  return new Promise((resolve, reject) => {
    try {
      if (!historyStream) return resolve({ id, title, date, messages, skippedLines: 0 });
      const rs = historyStream;
      let rl: readline.Interface | undefined;
      let lineIndex = 0;
      let done = false;
      let hitLineLimit = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { rl?.close(); } catch {}
        try { rs.destroy(); } catch {}
        const result = { id, title, date: (stat?.mtimeMs || Date.now()), messages: finalizeTurnDiffMessageOrder(), skippedLines: skipped };
        try {
          if (stat) {
            const key = filePath;
            // 简单 LRU：超过 200 条时清理前 50 条
            if (cache.size > 200) {
              let i = 0;
              for (const k of cache.keys()) { cache.delete(k); if (++i >= 50) break; }
            }
            cache.set(key, {
              parserVersion: PARSER_VERSION,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              complete: !hitLineLimit,
              maxLines,
              result,
            });
          }
        } catch {}
        resolve(result);
      };
      const fail = (err: any) => {
        if (done) return;
        done = true;
        try { rl?.close(); } catch {}
        try { rs.destroy(); } catch {}
        reject(err);
      };
      if (!rs.readableEncoding) {
        readBufferHistoryLines(rs, (line) => {
          if (done) return false;
          lineIndex = parseLine(line, lineIndex);
          if (Number.isFinite(maxLines) && lineIndex >= maxLines) {
            hitLineLimit = true;
            finish();
            return false;
          }
          return true;
        }).then(finish, fail);
        return;
      }
      rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (done) return;
        lineIndex = parseLine(line, lineIndex);
        if (Number.isFinite(maxLines) && lineIndex >= maxLines) {
          hitLineLimit = true;
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
      const result = { id, title, date: (stat?.mtimeMs || Date.now()), messages: finalizeTurnDiffMessageOrder(), skippedLines: skipped };
      try {
        if (stat) {
          const key = filePath;
          if (cache.size > 200) {
            let i = 0;
            for (const k of cache.keys()) { cache.delete(k); if (++i >= 50) break; }
          }
          cache.set(key, {
            parserVersion: PARSER_VERSION,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            complete: !Number.isFinite(maxLines),
            maxLines,
            result,
          });
        }
      } catch {}
      resolve(result);
    }
  });
}

// ---------------------------
// New: Persistent Index + Details Cache + Background Indexer
// ---------------------------


/**
 * 批量移除历史列表缓存中的文件路径，避免关联删除时重复读写同一个缓存文件。
 */
export async function removePathsFromCache(filePaths: readonly string[]) {
  try {
    const targets = new Set(
      (filePaths || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((item) => {
          const normalized = item.replace(/\\/g, "/");
          return process.platform === "win32" ? normalized.toLowerCase() : normalized;
        }),
    );
    if (targets.size === 0) return;
    const all = loadHistoryCache();
    let changed = false;
    const cleaned = (all || []).map((e) => {
      const before = Array.isArray(e.list) ? e.list.length : 0;
      const list = (e.list || []).filter((item) => {
        const normalized = String(item.filePath || "").replace(/\\/g, "/");
        const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
        return !targets.has(key);
      });
      if (list.length !== before) changed = true;
      return { ...e, list } as HistoryListCacheEntry;
    });
    if (changed) saveHistoryCache(cleaned);
  } catch {}
}

/**
 * 移除单个历史列表缓存路径；兼容旧调用方并复用批量实现。
 */
export async function removePathFromCache(filePath: string) {
  await removePathsFromCache([filePath]);
}

export default { listHistory, listHistorySplit, readHistoryFile, computeHistoryRoots, debugInfo, removePathFromCache, removePathsFromCache, purgeHistoryCacheIfOutdated };
