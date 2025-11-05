// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import { perfLogger } from "./log";
import { getDebugConfig } from "./debugConfig";
import { getSessionsRootCandidatesFastAsync, isUNCPath, uncToWsl } from "./wsl";
import { detectResumeInfo, detectRuntimeShell, detectRuntimeShellFromContent } from "./history";
import type { HistorySummary, Message, RuntimeShell } from "./history";

// 仅在存在时使用 chokidar；否则跳过监听
let chokidar: any = null;
try { chokidar = require("chokidar"); } catch {}

type FileSig = { mtimeMs: number; size: number };
type IndexSummary = HistorySummary & { dirKey: string };
type Details = {
  id: string;
  title: string;
  date: number;
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

const VERSION = "v6";

function getUserDataDir(): string {
  try { const { app } = require("electron"); return app.getPath("userData"); } catch { return process.cwd(); }
}

function indexPath(): string { return path.join(getUserDataDir(), "history.index.v6.json"); }
function detailsPath(): string { return path.join(getUserDataDir(), "history.details.v6.json"); }
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
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    return { version: VERSION, files: obj.files || {}, savedAt: Number(obj.savedAt || 0) } as PersistDetails;
  } catch { return { version: VERSION, files: {}, savedAt: 0 }; }
}

function saveDetails(d: PersistDetails) {
  try { fs.writeFileSync(detailsPath(), JSON.stringify(d, null, 2), "utf8"); } catch {}
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
// 预览文本过滤：跳过路径或空行，取第一段有效内容
// ------------------------------

/**
 * 规范化单行文本（去除首尾空白与成对包裹符）
 */
function normalizeLineHead(s: string): string {
  try {
    let t = String(s || "").trim();
    // 去除反引号/引号包裹（例如 `...`、"..."、'...')
    const stripPairs = (ch: string) => {
      if (t.startsWith(ch) && t.endsWith(ch) && t.length >= 2) t = t.slice(1, -1).trim();
    };
    stripPairs("`");
    stripPairs("\"");
    stripPairs("'");
    return t;
  } catch { return String(s || "").trim(); }
}

/**
 * 判断一行是否为 Windows/WSL 风格的路径行：
 * - Windows 盘符路径：C:\\ 或 C:/ 开头
 * - WSL UNC：\\wsl.localhost\\Distro\\... 或 //wsl.localhost/Distro/...
 * - 旧式 WSL 共享：\\wsl$\\Distro\\...
 * - /mnt/<drive>/... 挂载盘路径
 */
function isWinOrWslPathLine(line: string): boolean {
  try {
    const t = normalizeLineHead(line);
    if (!t) return false;
    // 支持 file: URI 形式的路径（例如：file:/C:/..., file:///C:/..., file://wsl.localhost/..., file:/mnt/c/...）
    if (/^file:\//i.test(t)) {
      if (/^file:\/+[A-Za-z]:[\\/]/i.test(t)) return true; // 盘符形式
      if (/^file:\/+wsl\.localhost\//i.test(t)) return true; // wsl.localhost 共享
      if (/^file:\/+mnt\/[a-zA-Z]\//i.test(t)) return true; // /mnt/<drive>
    }
    if (/^[A-Za-z]:[\\/]/.test(t)) return true;
    if (/^\\\\wsl\.localhost\\[^\\\s]+\\/.test(t)) return true;
    if (/^\\\\wsl\$\\[^\\\s]+\\/.test(t)) return true;
    if (/^\/\/wsl\.localhost\/[^\s/]+\//.test(t)) return true;
    if (/^\/mnt\/[a-zA-Z]\//.test(t)) return true;
    return false;
  } catch { return false; }
}

/**
 * 过滤预览文本：
 * - 按行拆分，跳过空行与路径行，返回首个有效内容行（trim 后）。
 * - 若找不到有效内容，返回空串。
 */
function filterPreviewText(raw: string): string {
  try {
    const lines = String(raw || "").split(/\r?\n/);
    for (const ln of lines) {
      if (!ln || /^\s*$/.test(ln)) continue;
      if (isWinOrWslPathLine(ln)) continue;
      return normalizeLineHead(ln);
    }
    return "";
  } catch { return ""; }
}

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
  return { id, title, date, filePath: fp, rawDate, dirKey, resumeMode, resumeId, runtimeShell };
}

async function parseDetails(fp: string, stat: fs.Stats): Promise<Details> {
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
        const openU = '<user_instructions>';
        const closeU = '</user_instructions>';
        const openE = '<environment_context>';
        const closeE = '</environment_context>';
        if (s2.toLowerCase().startsWith(openU)) {
          const idx = s2.toLowerCase().indexOf(closeU);
          if (idx >= 0) {
            const inner = s2.slice(openU.length, idx);
            picked.push({ type: 'instructions', text: inner });
            const rest = s2.slice(idx + closeU.length);
            return { rest: rest.trim(), picked };
          }
          picked.push({ type: 'instructions', text: s2.slice(openU.length) });
          return { rest: '', picked };
        }
        if (s2.toLowerCase().startsWith(openE)) {
          const idx = s2.toLowerCase().indexOf(closeE);
          if (idx >= 0) {
            const inner = s2.slice(openE.length, idx);
            picked.push({ type: 'environment_context', text: inner });
            const rest = s2.slice(idx + closeE.length);
            return { rest: rest.trim(), picked };
          }
          picked.push({ type: 'environment_context', text: s2.slice(openE.length) });
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
                      messages.push({ role: 'system', content: [{ type: 'instructions', text: t, tags: ['session_meta.instructions','session_instructions','instructions'] as any }] });
                    }
                  }
                  if (payload.git) {
                    messages.push({ role: 'state', content: [{ type: 'git', text: pretty(payload.git), tags: ['session_meta.git'] as any }] });
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
                      messages.push({ role: 'system', content: [{ type: 'instructions', text: t, tags: ['session_instructions','instructions'] as any }] });
                    }
                  }
                  if ((obj as any).git) {
                    messages.push({ role: 'state', content: [{ type: 'git', text: pretty((obj as any).git) }] });
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
                        const filtered = filterPreviewText(t);
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
                        const filtered = filterPreviewText(t);
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
                messages.push({ role, content: items });
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
              messages.push({ role: 'tool', content: [{ type: 'function_call', text, tags: ['function_call'] as any }] });
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
              messages.push({ role: 'tool', content: [{ type: 'function_output', text, tags: ['function_output'] as any }] });
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
              if (items.length) messages.push({ role: 'reasoning', content: items });
            } else if (obj.type === 'state' || obj.record_type === 'state' || ((obj as any).type === 'response_item' && (obj as any).payload && (((obj as any).payload.type === 'state') || ((obj as any).payload.record_type === 'state')))) {
              const src: any = ((obj as any).type === 'response_item' && (obj as any).payload) ? (obj as any).payload : obj;
              messages.push({ role: 'state', content: [{ type: 'state', text: JSON.stringify(src), tags: ['state'] as any }] });
            } else if (isSessionHeader) {
              const meta = { id: obj.id, timestamp: obj.timestamp, git: obj.git };
              messages.push({ role: 'meta', content: [{ type: 'session_meta', text: pretty(meta) }] });
            } else {
              messages.push({ role: String(obj.role || obj.type || 'unknown'), content: [{ type: String(obj.type || 'unknown'), text: pretty(obj) }] });
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
        resolve({ id, title, date, messages, skippedLines: skipped, rawDate, cwd, dirKey, preview, resumeMode, resumeId: finalResumeId, runtimeShell });
      });
      rs.on('error', () => {
        if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
        const finalResumeId = resumeId || id;
        resolve({ id, title, date, messages, skippedLines: skipped, rawDate, cwd, dirKey, preview, resumeMode, resumeId: finalResumeId, runtimeShell });
      });
    } catch {
      if (runtimeShell === 'unknown') runtimeShell = detectRuntimeShell(fp);
      const finalResumeId = resumeId || id;
      resolve({ id, title, date, messages, skippedLines: skipped, resumeMode, resumeId: finalResumeId, runtimeShell });
    }
  });
}

// 全局索引
const g: any = global as any;
if (!g.__indexer) g.__indexer = {};
if (!g.__indexer.retries) g.__indexer.retries = new Map<string, { count: number; timer?: NodeJS.Timeout }>();

export function getIndexedSummaries(): IndexSummary[] {
  const ix: PersistIndex = g.__indexer.index || { version: VERSION, files: {}, savedAt: 0 };
  return Object.values(ix.files)
    .map((x) => {
      const summary = x.summary;
      const shell = summary.runtimeShell && summary.runtimeShell !== 'unknown' ? summary.runtimeShell : detectRuntimeShell(summary.filePath);
      return { ...summary, runtimeShell: shell };
    })
    .sort((a, b) => b.date - a.date);
}

export function getIndexedDetails(filePath: string): Details | null {
  const det: PersistDetails = g.__indexer.details || { version: VERSION, files: {}, savedAt: 0 };
  const k = canonicalKey(filePath);
  const v = det.files[k]?.details;
  if (!v) return null;
  const shell = v.runtimeShell && v.runtimeShell !== 'unknown' ? v.runtimeShell : detectRuntimeShell(filePath);
  return { ...v, runtimeShell: shell };
}

export async function startHistoryIndexer(getWindow: () => BrowserWindow | null) {
  // 若被重复调用（例如调试期热重载），先停止既有 watcher/定时器，避免重复注册导致内存泄漏
  try {
    await stopHistoryIndexer();
  } catch {}
  await perfLogger.time("indexer.start", async () => {
    // 1) 读取持久化缓存
    g.__indexer.index = loadIndex();
    g.__indexer.details = loadDetails();

    // 2) 计算根目录（不扫描）
    const rootCandidates = await getSessionsRootCandidatesFastAsync();
    const roots = Array.from(new Set(rootCandidates.map((c) => c.path)));
    const rootsExisting = rootCandidates.filter((c) => c.exists).map((c) => c.path);
    const rootsMissing = rootCandidates.filter((c) => !c.exists).map((c) => c.path);
    perfLogger.log(`[roots] existing=${JSON.stringify(rootsExisting)} missing=${JSON.stringify(rootsMissing)}`);
    try {
      (g.__indexer as any).roots = roots.slice();
      (g.__indexer as any).missingRoots = rootsMissing.slice();
      (g.__indexer as any).existingRoots = rootsExisting.slice();
    } catch {}

    // 3) 枚举所有 .jsonl 文件并比对签名，增量更新
    const files: string[] = [];
    const scanLimit = pLimit(8);
    await Promise.all(roots.map((root) => scanLimit(async () => {
      try {
        const years = await fsp.readdir(root, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
        for (const y of years) {
          const ydir = path.join(root, y);
          const months = await fsp.readdir(ydir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
          for (const m of months) {
            const mdir = path.join(ydir, m);
            const days = await fsp.readdir(mdir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
            for (const d of days) {
              const ddir = path.join(mdir, d);
              const fsx = await fsp.readdir(ddir).then((fs0) => fs0.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
              for (const f of fsx) files.push(path.join(ddir, f));
            }
          }
        }
      } catch {}
    })));
    perfLogger.log(`[files] count=${files.length}`);

    const ix: PersistIndex = g.__indexer.index;
    const det: PersistDetails = g.__indexer.details;
    const win = getWindow();

    const workLimit = pLimit(8);
    let updatedSummaries = 0;
    let updatedDetails = 0;
    const batch: IndexSummary[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      try { win?.webContents.send('history:index:add', { items: batch.splice(0, batch.length) }); } catch {}
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
            const details = await parseDetails(fp, stat);
            const fallbackDir = dirKeyOf(fp);
            const hasCwd = !!(details.cwd && String(details.cwd).trim());
            const gotProjectDir = hasCwd && (details.dirKey && details.dirKey !== fallbackDir);
            const summary: IndexSummary = {
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
            det.files[k] = { sig, details };
            ix.files[k] = { sig, summary };
            ix.savedAt = Date.now(); det.savedAt = Date.now();
            saveIndex(ix); saveDetails(det);
            if (gotProjectDir) {
              try { win?.webContents.send('history:index:update', { item: summary }); } catch {}
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

    await Promise.all(files.map((fp) => workLimit(async () => {
      try {
        const stat = await fsp.stat(fp).catch(() => null as any);
        if (!stat) return;
        const k = canonicalKey(fp);
        const sig: FileSig = { mtimeMs: stat.mtimeMs, size: stat.size };
        const prev = ix.files[k]?.sig;
        const same = prev && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size;
        if (!same) {
          const details = await parseDetails(fp, stat);
          det.files[k] = { sig, details };
          updatedDetails++;
          const summary: IndexSummary = {
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
    if (chokidar && roots.length > 0) {
      const onChange = async (fp: string) => {
          try {
            const stat = await fsp.stat(fp).catch(() => null as any);
            if (!stat) return;
            const k = canonicalKey(fp);
            const sig: FileSig = { mtimeMs: stat.mtimeMs, size: stat.size };
            // 先解析 details 并直接构造 summary，零额外 IO
            const details = await parseDetails(fp, stat);
            det.files[k] = { sig, details };
            const summary: IndexSummary = {
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
            try { win?.webContents.send('history:index:update', { item: summary }); } catch {}
            try {
              const fallbackDir = dirKeyOf(fp);
              const hasCwd = !!(details.cwd && String(details.cwd).trim());
              if (!hasCwd || (summary.dirKey === fallbackDir)) {
                await scheduleReparse(fp, 2000, hasCwd ? 'dirKey=fallback(change)' : 'no-cwd(change)');
              }
            } catch {}
          } catch {}
        };
        const onUnlink = (fp: string) => {
          try {
            const k = canonicalKey(fp);
            const removed = ix.files[k]?.summary;
            delete ix.files[k]; delete det.files[k];
            ix.savedAt = Date.now(); det.savedAt = Date.now(); saveIndex(ix); saveDetails(det);
            if (removed) try { win?.webContents.send('history:index:remove', { filePath: fp }); } catch {}
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
        const uncRoots = roots.filter((r) => isUNC(r));
        const localRoots = roots.filter((r) => !isUNC(r));

        const makeGlobs = (rs: string[]) => {
          const out: string[] = [];
          for (const r of rs) {
            try {
              // 同时提供反斜杠样式与 POSIX 样式的 glob，提升 UNC/Windows 兼容性
              const back = path.join(r, '**', '*.jsonl');
              out.push(back);
              const posix = r.replace(/\\/g, '/').replace(/\/+$/g, '') + '/**/*.jsonl';
              out.push(posix);
            } catch {
              try { out.push(path.join(r, '**', '*.jsonl')); } catch {}
            }
          }
          return out;
        };

        const watchers: any[] = [];
        try {
          if (localRoots.length > 0) {
            const globsLocal = makeGlobs(localRoots);
            idxLog(`[watch:init local] globs=${JSON.stringify(globsLocal)}`);
            const w1 = chokidar.watch(globsLocal, {
              ignoreInitial: true,
              awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
              depth: 6,
            });
            w1.on('add', onChange).on('change', onChange).on('unlink', onUnlink).on('error', (e: any) => { perfLogger.log(`[watch:error local] ${String(e)}`); });
            // ready 时记录
            try { w1.on('ready', () => { idxLog(`[watch:ready local] paths=${JSON.stringify(localRoots)}`); }); } catch {}
            watchers.push(w1);
          }
        } catch (e) { perfLogger.log(`[watch:init local failed] ${String(e)}`); }
        try {
          if (uncRoots.length > 0) {
            // UNC 到 WSL 的共享不可靠，使用轮询模式
            const globsUNC = makeGlobs(uncRoots);
            idxLog(`[watch:init unc] globs=${JSON.stringify(globsUNC)}`);
            const w2 = chokidar.watch(globsUNC, {
              ignoreInitial: true,
              awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
              depth: 6,
              usePolling: true,
              interval: 2500,
              binaryInterval: 4000,
              followSymlinks: false,
            });
            w2.on('add', onChange).on('change', onChange).on('unlink', onUnlink).on('error', (e: any) => { perfLogger.log(`[watch:error unc] ${String(e)}`); });
            try { w2.on('ready', () => { idxLog(`[watch:ready unc] paths=${JSON.stringify(uncRoots)}`); }); } catch {}
            watchers.push(w2);
          }
        } catch (e) { perfLogger.log(`[watch:init unc failed] ${String(e)}`); }
        g.__indexer.watchers = watchers;
        perfLogger.log(`[watch] enabled using chokidar (local=${localRoots.length}, unc=${uncRoots.length})`);
        // 5) 周期性轻量重扫：仅扫描当天与前一天目录，弥补 UNC 监听遗漏的新增/变更
        try {
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
              const details = await parseDetails(fp, stat);
              det.files[k] = { sig, details };
              const summary: IndexSummary = {
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
              try { win?.webContents.send('history:index:update', { item: summary }); } catch {}
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
              for (const r of roots) {
                const filesToday = await listDayDir(r, today);
                const filesYest = await listDayDir(r, yesterday);
                const files = Array.from(new Set([...filesToday, ...filesYest]));
                await Promise.all(files.map((fp) => limit2(() => upsertQuick(fp))));
              }
            } catch (e) { idxLog(`[rescan:error] err=${String(e)}`); }
          }, 6000);
          try { (g.__indexer as any).rescanTimer = timer; } catch {}
        } catch (e) { idxLog(`[rescan:init failed] ${String(e)}`); }
      } else { perfLogger.log(`[watch] disabled (no chokidar)`); }
  });
}

export function getLastIndexerRoots(): string[] {
  try { const roots: string[] = (g.__indexer && g.__indexer.roots) ? g.__indexer.roots : []; return Array.isArray(roots) ? roots : []; } catch { return []; }
}

// 供主进程在删除文件后主动清理索引与详情缓存，避免切换项目时已删除项回流
export function removeFromIndex(filePath: string): boolean {
  try {
    const ix: PersistIndex = g.__indexer.index || { version: VERSION, files: {}, savedAt: 0 };
    const det: PersistDetails = g.__indexer.details || { version: VERSION, files: {}, savedAt: 0 };
    const k = canonicalKey(filePath);
    const existed = !!ix.files[k] || !!det.files[k];
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
}
