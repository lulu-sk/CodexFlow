// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import { wslToUNC, isUNCPath, uncToWsl, getCodexRootsFastAsync } from "./wsl";
import { getClaudeRootCandidatesFastAsync, discoverClaudeSessionFiles } from "./agentSessions/claude/discovery";
import { getGeminiRootCandidatesFastAsync, discoverGeminiSessionFiles } from "./agentSessions/gemini/discovery";
import { parseClaudeSessionFile } from "./agentSessions/claude/parser";
import { parseGeminiSessionFile, extractGeminiProjectHashFromPath } from "./agentSessions/gemini/parser";
import { perfLogger } from "./log";
import { getDebugConfig } from "./debugConfig";
import settings from "./settings";

export type Project = {
  id: string;
  name: string;
  winPath: string;
  wslPath: string;
  hasDotCodex: boolean;
  createdAt: number;
  lastOpenedAt?: number;
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function getStorePath() { const dir = app.getPath('userData'); return path.join(dir, 'projects.json'); }
function loadStore(): Project[] { try { const p = getStorePath(); if (!fs.existsSync(p)) return []; return JSON.parse(fs.readFileSync(p, 'utf8')) as Project[]; } catch { return []; } }
function saveStore(list: Project[]) { try { fs.writeFileSync(getStorePath(), JSON.stringify(list, null, 2), 'utf8'); } catch {} }
async function saveStoreAsync(list: Project[]) { try { await fsp.writeFile(getStorePath(), JSON.stringify(list, null, 2), 'utf8'); } catch {} }
async function pathExists(p: string): Promise<boolean> { try { await fsp.access(p); return true; } catch { return false; } }

// 防抖：短时间内的并发调用合并为一次
let __scanPromise: Promise<Project[]> | null = null;
let __scanStamp = 0;
export async function scanProjectsAsync(_roots?: string[], verbose = false): Promise<Project[]> {
  const now = Date.now();
  if (__scanPromise && (now - __scanStamp) < 1500) {
    return __scanPromise;
  }
  __scanStamp = now;
  __scanPromise = (async () => {
  const store = loadStore();
  const logPath = path.join(app.getPath('userData'), 'scan-log.txt');
  const dbgPath = path.join(app.getPath('userData'), 'projects-debug.log');
  const dbgEnabled = () => { try { return !!getDebugConfig().projects.debug; } catch { return false; } };
  const writeLog = async (msg: string) => { if (!verbose) return; try { await fsp.appendFile(logPath, `${new Date().toISOString()} ${msg}\n`, 'utf8'); } catch {} };
  const writeDbg = async (msg: string) => {
    if (!dbgEnabled()) return;
    const line = `${new Date().toISOString()} ${msg}\n`;
    try { await fsp.appendFile(dbgPath, line, 'utf8'); } catch {}
    try { await fsp.appendFile(path.join(process.cwd(), 'projects-debug.log'), line, 'utf8'); } catch {}
  };

  const rootsInfo = await perfLogger.time('projectsFast.getCodexRootsFastAsync', () => getCodexRootsFastAsync());
  await writeDbg(`[FAST] windowsSessions='${rootsInfo.windowsSessions}' wslSessions=${rootsInfo.wsl.length}`);
  const sessionRoots: { root: string; distro?: string }[] = [];
  sessionRoots.push({ root: rootsInfo.windowsSessions });
  for (const w of rootsInfo.wsl) sessionRoots.push({ root: w.sessionsUNC, distro: w.distro });

  const projects: Project[] = [];
  const seen = new Set<string>();
  // 显示用：不改变大小写，仅规范分隔符/前后斜杠
  const normWsl = (p?: string): string => {
    if (!p) return '';
    try {
      let s = String(p).replace(/\\/g, '/');
      while (s.includes('//')) s = s.replace(/\/\//g, '/');
      if (!s.startsWith('/')) s = '/' + s;
      if (s.length > 1) s = s.replace(/\/+$/, '');
      return s;
    } catch { return String(p || ''); }
  };
  // 去重键：在 norm 基础上转为小写
  const normWslKey = (p?: string): string => normWsl(p).toLowerCase();
  const canonKey = (winPath?: string, wslPath?: string): string => {
    const w = wslPath && wslPath.trim().length > 0 ? normWslKey(wslPath) : normWslKey(winPath ? ruleWinToWsl(winPath) : '');
    return w || (winPath ? winPath.replace(/\\/g, '/').toLowerCase() : '');
  };
  // 仅做真实存在性校验（交给 fs.stat 判定），不过度限制路径格式
  const ensureDirExists = async (p?: string) => {
    if (!p || typeof p !== 'string') return false;
    try { const st = await fsp.stat(p); return st.isDirectory(); } catch { return false; }
  };
  const limit = (function pLimit(max: number) { let running = 0; const q: (() => void)[] = []; const next = () => { running--; const fn = q.shift(); if (fn) fn(); }; return function<T>(task: () => Promise<T>) { return new Promise<T>((resolve, reject) => { const run = () => { running++; task().then((v) => { next(); resolve(v); }).catch((e) => { next(); reject(e); }); }; if (running < max) run(); else q.push(run); }); }; })(8);
  const readPrefix = async (fp: string) => await new Promise<string>((resolve) => {
    try { const rs = fs.createReadStream(fp, { encoding: 'utf8', start: 0, end: 128 * 1024 - 1 }); let buf = ''; rs.on('data', (c) => { buf += c; if (buf.length >= 128 * 1024) { try { rs.close(); } catch {} resolve(buf); } }); rs.on('end', () => resolve(buf)); rs.on('error', () => resolve('')); } catch { resolve(''); }
  });
  const ruleWinToWsl = (p: string): string => { try { if (isUNCPath(p)) { const u = uncToWsl(p); if (u) return u.wslPath; } const m = p.match(/^([a-zA-Z]):\\(.*)$/); if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`; return p; } catch { return p; } };
  const storeMap = new Map<string, Project>();
  for (const item of store) {
    try {
      const key = canonKey(item.winPath, item.wslPath);
      if (key && !storeMap.has(key)) storeMap.set(key, item);
    } catch {}
  }

  // 日志降噪：按根目录聚合统计，仅采样少量示例
  const DBG_MAX_SAMPLES = 3;
  type Agg = { root: string; distro?: string; files: number; matched: number; added: number; skippedUnmatched: number; skippedRegex: number; samples: { matched: string[]; added: string[]; skipped: string[] } };
  const dbgAgg: Record<string, Agg> = {};
  const getAgg = (root: string, distro?: string): Agg => {
    const key = `${root}||${distro || ''}`;
    if (!dbgAgg[key]) dbgAgg[key] = { root, distro, files: 0, matched: 0, added: 0, skippedUnmatched: 0, skippedRegex: 0, samples: { matched: [], added: [], skipped: [] } };
    return dbgAgg[key];
  };

  /**
   * 从会话解析得到的 cwd 推导项目并入库（统一去重 + 兼容 WSL/UNC/Windows 路径）。
   */
  const addProjectFromCwd = async (rawCwd: string, ctx: { root: string; distro?: string }) => {
    try {
      let raw = String(rawCwd || '').trim();
      if (!raw) return;
      raw = raw.replace(/^\"|\"$/g, '').trim();
      raw = raw.split(/\\n|\r?\n|<\/?[a-zA-Z_:-]+>/)[0].trim();
      raw = raw.replace(/\\\\/g, '\\');
      raw = raw.replace(/[\\/]+$/g, '');
      if (!raw) return;
      if (/\(\?:/.test(raw) || /\\r\?/.test(raw)) return;

      let winPathGuess = '';
      let wslPathGuess = '';
      if (/^\//.test(raw)) {
        wslPathGuess = normWsl(raw);
        if (isUNCPath(ctx.root)) {
          const info = uncToWsl(ctx.root);
          const distroName = info?.distro || ctx.distro || 'Ubuntu-24.04';
          winPathGuess = wslToUNC(wslPathGuess, distroName);
        } else {
          const mnt = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
          if (mnt) winPathGuess = `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`;
        }
      } else if (/^[A-Za-z]:\\/.test(raw) || /^\\\\[^\s"'\\]+\\[^\s"'\\]+/.test(raw)) {
        winPathGuess = raw;
        wslPathGuess = normWsl(ruleWinToWsl(raw));
      } else {
        return;
      }

      const cleanWin = (winPathGuess || '').trim();
      const cleanWsl = normWsl((wslPathGuess || '').trim());
      if (!cleanWin) return;

      const key = canonKey(cleanWin, cleanWsl);
      if (!key || seen.has(key)) return;
      seen.add(key);

      // 优先接受真实存在的目录；若不存在，也依据会话记录纳入（"会话即真相"）
      await ensureDirExists(cleanWin);

      const name = (cleanWin ? path.basename(cleanWin) : (cleanWsl ? cleanWsl.split('/').pop() : '')) || 'project';
      const hasDot = (await pathExists(path.join(cleanWin, '.codex'))) || (await pathExists(path.join(cleanWin, 'codex.json')));
      projects.push({ id: uid(), name, winPath: cleanWin, wslPath: cleanWsl, hasDotCodex: hasDot, createdAt: Date.now() });
    } catch {}
  };

  await perfLogger.time('projectsFast.enumerate', async () => {
    await Promise.all(sessionRoots.map(({ root, distro }) => limit(async () => {
      try {
        const years = await fsp.readdir(root, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
        for (const y of years) {
          const ydir = path.join(root, y);
          const months = await fsp.readdir(ydir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
          for (const m of months) {
            const mdir = path.join(ydir, m);
            const days = await fsp.readdir(mdir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
            for (const dday of days) {
              const ddir = path.join(mdir, dday);
              const files = await fsp.readdir(ddir).then((fsx) => fsx.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
              for (const f of files) {
                const fp = path.join(ddir, f);
                try {
                  const agg = getAgg(root, distro);
                  agg.files++;
                  const prefix = await readPrefix(fp);
                  const first = (prefix.split(/\r?\n/).find(Boolean) || '').trim();
                  let raw = '';
                  // Codex 新版 JSONL：首行通常为 { type:'session_meta', payload:{ cwd } }（而非顶层 cwd）
                  try {
                    const obj = JSON.parse(first);
                    if (typeof obj?.cwd === 'string') raw = obj.cwd;
                    else if (typeof obj?.payload?.cwd === 'string') raw = obj.payload.cwd;
                    else if (typeof obj?.working_dir === 'string') raw = obj.working_dir;
                    else if (typeof obj?.payload?.working_dir === 'string') raw = obj.payload.working_dir;
                  } catch {}
                  if (!raw) {
                    const m1 = (prefix || '').match(/Current\s+working\s+directory:\s*([^\r\n]+)/i); if (m1?.[1]) raw = m1[1];
                    const m2 = (prefix || '').match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i); if (!raw && m2?.[1]) raw = m2[1];
                  }
                  {
                    let s = String(raw || '');
                    s = s.replace(/^\"|\"$/g, '').trim();
                    // 截断到首个 JSON 转义换行或标签边界，避免把后续说明拼进路径
                    s = s.split(/\\n|\r?\n|<\/?[a-zA-Z_:-]+>/)[0].trim();
                    // 折叠 JSON 转义双反斜杠，避免盘符路径误判
                    s = s.replace(/\\\\/g, '\\');
                    s = s.replace(/[\\/]+$/g, '');
                    raw = s;
                  }
                  if (!raw) continue;
                  let winPathGuess = '';
                  let wslPathGuess = '';
                  if (/^\//.test(raw)) {
                    wslPathGuess = normWsl(raw);
                    if (isUNCPath(root)) {
                      const info = uncToWsl(root);
                      const distroName = info?.distro || distro || 'Ubuntu-24.04';
                      winPathGuess = wslToUNC(wslPathGuess, distroName);
                    } else {
                      const mnt = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
                      if (mnt) winPathGuess = `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`;
                    }
                  } else if (/^[A-Za-z]:\\/.test(raw) || /^\\\\[^\s"'\\]+\\[^\s"'\\]+/.test(raw)) {
                    winPathGuess = raw;
                    wslPathGuess = normWsl(ruleWinToWsl(raw));
                  } else {
                    // 降噪：仅计数并采样
                    agg.skippedUnmatched++;
                    if (agg.samples.skipped.length < DBG_MAX_SAMPLES) agg.samples.skipped.push(`raw='${raw}' file='${fp}'`);
                    continue;
                  }
                  // 进一步排除明显的正则片段（例如 "(?:" 或 "\r?"），避免误把示例正则当作路径
                  try {
                    if (/\(\?:/.test(raw) || /\\r\?/.test(raw)) {
                      agg.skippedRegex++;
                      if (agg.samples.skipped.length < DBG_MAX_SAMPLES) agg.samples.skipped.push(`regex-like raw='${raw}' file='${fp}'`);
                      continue;
                    }
                  } catch {}
                  // 降噪：计数并采样匹配样本
                  agg.matched++;
                  if (agg.samples.matched.length < DBG_MAX_SAMPLES) agg.samples.matched.push(`file='${fp}' wsl='${wslPathGuess}' win='${winPathGuess}'`);
                  const cleanWin = (winPathGuess || '').trim();
                  const cleanWsl = normWsl((wslPathGuess || '').trim());
                  // 优先接受真实存在的目录；若不存在，也依据会话记录纳入（"会话即真相"），避免漏掉历史项目
                  const exists = await ensureDirExists(cleanWin);
                  const key = canonKey(cleanWin, cleanWsl);
                  if (seen.has(key)) continue;
                  seen.add(key);
                  const name = (cleanWin ? path.basename(cleanWin) : (cleanWsl ? cleanWsl.split('/').pop() : '')) || 'project';
                  const hasDot = (await pathExists(path.join(cleanWin, '.codex'))) || (await pathExists(path.join(cleanWin, 'codex.json')));
                  projects.push({ id: uid(), name, winPath: cleanWin, wslPath: cleanWsl, hasDotCodex: hasDot, createdAt: Date.now() });
                  agg.added++;
                  if (agg.samples.added.length < DBG_MAX_SAMPLES) agg.samples.added.push(`name='${name}' wsl='${cleanWsl}' win='${cleanWin}' dot=${hasDot}`);
                } catch {}
              }
            }
          }
        }
      } catch {}
    })));
  });

  // Claude Code：从会话中提取 cwd 以补全项目列表（Windows + WSL）
  await perfLogger.time('projectsFast.enumerateClaude', async () => {
    try {
      const includeAgentHistory = !!(settings.getSettings() as any)?.claudeCode?.readAgentHistory;
      const roots = (await getClaudeRootCandidatesFastAsync()).filter((c) => c.exists);
      await Promise.all(roots.map(({ path: root, distro }) => limit(async () => {
        try {
          const files = await discoverClaudeSessionFiles(root, { includeAgentHistory });
          for (const fp of files) {
            try {
              const stat = await fsp.stat(fp).catch(() => null as any);
              if (!stat) continue;
              const maxLines = includeAgentHistory ? 2000 : 400;
              const det = await parseClaudeSessionFile(fp, stat, { summaryOnly: true, maxLines });
              if (!includeAgentHistory && !det?.preview) continue;
              if (det?.cwd) await addProjectFromCwd(String(det.cwd), { root, distro });
            } catch {}
          }
        } catch {}
      })));
    } catch {}
  });

  // Gemini CLI：尝试从 session JSON 中提取 cwd（若无法解析则跳过）
  await perfLogger.time('projectsFast.enumerateGemini', async () => {
    try {
      const roots = (await getGeminiRootCandidatesFastAsync()).filter((c) => c.exists);
      await Promise.all(roots.map(({ path: root, distro }) => limit(async () => {
        try {
          const files = await discoverGeminiSessionFiles(root);
          const picked: string[] = [];
          const seenHash = new Set<string>();
          for (const fp of files) {
            const h = extractGeminiProjectHashFromPath(fp);
            if (!h || seenHash.has(h)) continue;
            seenHash.add(h);
            picked.push(fp);
          }
          for (const fp of picked) {
            try {
              const stat = await fsp.stat(fp).catch(() => null as any);
              if (!stat) continue;
              const det = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 2 * 1024 * 1024 });
              if (det?.cwd) await addProjectFromCwd(String(det.cwd), { root, distro });
            } catch {}
          }
        } catch {}
      })));
    } catch {}
  });

  // 输出聚合摘要（一次性、低噪声）
  try {
    const keys = Object.keys(dbgAgg);
    if (keys.length > 0) {
      for (const k of keys) {
        const a = dbgAgg[k];
        await writeDbg(`[FAST:SUMMARY] root='${a.root}' distro='${a.distro || ''}' files=${a.files} matched=${a.matched} added=${a.added} skipped_unmatched=${a.skippedUnmatched} skipped_regex=${a.skippedRegex}`);
        if (a.samples.matched.length > 0) await writeDbg(`[FAST:SAMPLE matched] ${a.samples.matched.join(' | ')}`);
        if (a.samples.added.length > 0) await writeDbg(`[FAST:SAMPLE added] ${a.samples.added.join(' | ')}`);
        if (a.samples.skipped.length > 0) await writeDbg(`[FAST:SAMPLE skipped] ${a.samples.skipped.join(' | ')}`);
      }
    }
  } catch {}

  if (projects.length > 0) {
    // 最终再做一次基于规范化 WSL 路径的去重
    const uniqueMap = new Map<string, Project>();
    for (const p of projects) {
      const k = canonKey(p.winPath, p.wslPath);
      if (!k || uniqueMap.has(k)) continue;
      // 规范名称：优先 Windows/UNC 末级，保留大小写
      const fixedName = p.winPath ? path.basename(p.winPath) : (p.wslPath ? p.wslPath.split('/').pop() || p.name : p.name);
      const prev = storeMap.get(k);
      if (prev) {
        const preservedCreatedAt = typeof prev.createdAt === "number" && !Number.isNaN(prev.createdAt) ? prev.createdAt : p.createdAt;
        const preservedLastOpenedAt = typeof prev.lastOpenedAt === "number" && !Number.isNaN(prev.lastOpenedAt) ? prev.lastOpenedAt : p.lastOpenedAt;
        uniqueMap.set(k, {
          ...prev,
          ...p,
          id: prev.id || p.id,
          createdAt: preservedCreatedAt,
          lastOpenedAt: preservedLastOpenedAt,
          name: fixedName || prev.name || p.name,
        });
        continue;
      }
      uniqueMap.set(k, { ...p, name: fixedName || p.name });
    }
    const unique = Array.from(uniqueMap.values());
    try { await saveStoreAsync(unique); } catch {}
    return unique;
  }
  // 无新增时，清理旧存量的无效项目，避免“无中生有”
  const cleaned: Project[] = [];
  for (const s of store) {
    try {
      if (await ensureDirExists(s.winPath)) {
        const fixedName = s.winPath ? path.basename(s.winPath) : (s.wslPath ? s.wslPath.split('/').pop() || s.name : s.name);
        cleaned.push({ ...s, name: fixedName || s.name });
      }
    } catch {}
  }
  if (cleaned.length !== store.length) { try { await saveStoreAsync(cleaned); } catch {} }
  return cleaned;
  })();
  try { const res = await __scanPromise; return res; } finally { /* 保持 window 期内复用 */ }
}

export function addProjectByWinPath(winPath: string): Project | null {
  try {
    const normalized = path.resolve(winPath);
    // 仅规则转换，避免唤起 wsl.exe
    const m = normalized.match(/^([a-zA-Z]):\\(.*)$/);
    const wslPath = m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : normalized;
    const store = loadStore();
    const exists = store.find((s) => s.winPath === normalized);
    if (exists) return exists;
    const proj: Project = {
      id: uid(),
      name: path.basename(normalized),
      winPath: normalized,
      wslPath,
      hasDotCodex: fs.existsSync(path.join(normalized, '.codex')) || fs.existsSync(path.join(normalized, 'codex.json')),
      createdAt: Date.now(),
      lastOpenedAt: undefined
    };
    store.push(proj);
    saveStore(store);
    return proj;
  } catch { return null; }
}

export function touchProject(id: string) {
  const store = loadStore();
  const p = store.find((s) => s.id === id);
  if (p) { p.lastOpenedAt = Date.now(); saveStore(store); }
}

export default { scanProjectsAsync, addProjectByWinPath, touchProject };
