// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import { winToWsl, wslToUNC, isUNCPath, uncToWsl, listDistrosAsync, getDistroHomeAsync, execInWslAsync, readFileInWslAsync, winToWslAsync, getDefaultRootsAsync } from './wsl';

/** 项目管理: scan/add/touch, 本地缓存 projects.json 存放 metadata */

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

function getStorePath() {
  const dir = app.getPath('userData');
  return path.join(dir, 'projects.json');
}

// ---- Fast-path meta for scan skip when unchanged ----
type RootMetaSig = { root: string; entryCount: number; mtimeMs: number };
type SessionRootSig = { root: string; latestDir?: string; latestFile?: string; mtimeMs?: number; size?: number };
type ProjectsScanMeta = {
  roots: string[];
  rootSigs: RootMetaSig[];
  sessionSigs: SessionRootSig[];
  savedAt: number;
};

function getScanMetaPath() {
  const dir = app.getPath('userData');
  return path.join(dir, 'projects.scan.meta.json');
}

function loadScanMeta(): ProjectsScanMeta | null {
  try {
    const p = getScanMetaPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ProjectsScanMeta;
  } catch { return null; }
}

function saveScanMeta(meta: ProjectsScanMeta) {
  try { fs.writeFileSync(getScanMetaPath(), JSON.stringify(meta, null, 2), 'utf8'); } catch {}
}

async function computeRootMetaSig(root: string): Promise<RootMetaSig> {
  let entryCount = 0; let mtimeMs = 0;
  try {
    const st = await fsp.stat(root); mtimeMs = st.mtimeMs;
  } catch {}
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [] as any[]);
    entryCount = entries.filter((e: any) => e && typeof e.isDirectory === 'function' ? e.isDirectory() : false).length;
  } catch {}
  return { root, entryCount, mtimeMs };
}

async function computeSessionRootSig(root: string): Promise<SessionRootSig> {
  const sig: SessionRootSig = { root };
  try {
    const years = await fsp.readdir(root, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
    const ySorted = years.slice().sort((a, b) => Number(b) - Number(a));
    for (const y of ySorted) {
      const ydir = path.join(root, y);
      const months = await fsp.readdir(ydir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
      const mSorted = months.slice().sort((a, b) => Number(b) - Number(a));
      for (const m of mSorted) {
        const mdir = path.join(ydir, m);
        const days = await fsp.readdir(mdir, { withFileTypes: true }).then((ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name)).catch(() => [] as string[]);
        const dSorted = days.slice().sort((a, b) => Number(b) - Number(a));
        for (const dday of dSorted) {
          const ddir = path.join(mdir, dday);
          const files = await fsp.readdir(ddir).then((fsx) => fsx.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
          let best: { fp: string; mtimeMs: number; size: number } | null = null;
          for (const f of files) {
            const fp = path.join(ddir, f);
            try {
              const st = await fsp.stat(fp);
              if (!best || st.mtimeMs > best.mtimeMs) best = { fp, mtimeMs: st.mtimeMs, size: st.size };
            } catch {}
          }
          if (best) { sig.latestDir = ddir; sig.latestFile = best.fp; sig.mtimeMs = best.mtimeMs; sig.size = best.size; return sig; }
        }
      }
    }
  } catch {}
  return sig;
}

function sameRootSigs(a: RootMetaSig[], b: RootMetaSig[]): boolean {
  if (a.length !== b.length) return false;
  const aa = a.slice().sort((x, y) => x.root.localeCompare(y.root));
  const bb = b.slice().sort((x, y) => x.root.localeCompare(y.root));
  for (let i = 0; i < aa.length; i++) {
    if (aa[i].root !== bb[i].root) return false;
    if (aa[i].entryCount !== bb[i].entryCount) return false;
    if (Math.floor(aa[i].mtimeMs) !== Math.floor(bb[i].mtimeMs)) return false;
  }
  return true;
}

function sameSessionSigs(a: SessionRootSig[], b: SessionRootSig[]): boolean {
  if (a.length !== b.length) return false;
  const aa = a.slice().sort((x, y) => x.root.localeCompare(y.root));
  const bb = b.slice().sort((x, y) => x.root.localeCompare(y.root));
  for (let i = 0; i < aa.length; i++) {
    if (aa[i].root !== bb[i].root) return false;
    if (String(aa[i].latestFile || '') !== String(bb[i].latestFile || '')) return false;
    if (Math.floor(Number(aa[i].mtimeMs || 0)) !== Math.floor(Number(bb[i].mtimeMs || 0))) return false;
  }
  return true;
}

function loadStore(): Project[] {
  try {
    const p = getStorePath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as Project[];
  } catch (e) {
    return [];
  }
}

function saveStore(list: Project[]) {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    // noop
  }
}

async function saveStoreAsync(list: Project[]) {
  try {
    await fsp.writeFile(getStorePath(), JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function statIsDir(p: string): Promise<boolean> {
  try { const s = await fsp.stat(p); return s.isDirectory(); } catch { return false; }
}



export async function scanProjectsAsync(roots?: string[], verbose = false): Promise<Project[]> {
  const store = loadStore();
  const logPath = path.join(app.getPath('userData'), 'scan-log.txt');
  const dbgPath = path.join(app.getPath('userData'), 'projects-debug.log');
  const dbgFlagPath = path.join(app.getPath('userData'), 'projects-debug.on');
  const envDbg = String(process.env.CODEX_PROJECTS_DEBUG || '').trim() === '1';
  const dbgEnabled = () => envDbg || (() => { try { fs.accessSync(dbgFlagPath); return true; } catch { return false; } })();
  const writeLog = async (msg: string) => {
    if (!verbose) return;
    try { await fsp.appendFile(logPath, `${new Date().toISOString()} ${msg}\n`, 'utf8'); } catch {};
  };
  const writeDbg = async (msg: string) => {
    if (!dbgEnabled()) return;
    const line = `${new Date().toISOString()} ${msg}\n`;
    try { await fsp.appendFile(dbgPath, line, 'utf8'); } catch {}
    // 兜底：同时尝试写入当前工作目录，便于定位
    try { await fsp.appendFile(path.join(process.cwd(), 'projects-debug.log'), line, 'utf8'); } catch {}
  };
  let rootsToScan: string[] = [];
  let sessionProjects: Project[] = [];

  // 尝试从 sessions 反向映射项目（异步，非阻塞主线程）
  try {
    sessionProjects = [];
    const distros = await listDistrosAsync();
    await writeDbg(`[WSL] distros=${distros.map(d=>d.name).join(',')}`);
    for (const d of distros) {
      const home = await getDistroHomeAsync(d.name);
      if (!home) continue;
      const findOut = await execInWslAsync(d.name, `find \"${home}/.codex/sessions\" -type f -name \"*.jsonl\" 2>/dev/null || true`);
      if (!findOut) continue;
      const jsonFiles = findOut.split(/\r?\n/).filter(Boolean);
      await writeDbg(`[WSL] ${d.name} sessions files=${jsonFiles.length}`);
      for (const jf of jsonFiles) {
        try {
          const content = await readFileInWslAsync(d.name, jf);
          if (!content) continue;
          let cwdMatch = content.match(/Current working directory:\s*(.+?)(?:\r?\n|\\n|$)/i) || content.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
          if (cwdMatch && cwdMatch[1]) {
            let rawPath = cwdMatch[1].trim();
            rawPath = rawPath.replace(/^"|"$/g, '').trim();
            rawPath = rawPath.split(/\\n|\r?\n/)[0].trim();
            rawPath = rawPath.replace(/\\+$/g, '');
            rawPath = rawPath.replace(/\\\\/g, '\\');
            let wslPathCandidate: string | undefined = undefined;
            let projectWinPath: string | undefined = undefined;
            if (rawPath.startsWith('/')) {
              wslPathCandidate = rawPath;
              projectWinPath = wslToUNC(wslPathCandidate, d.name);
            } else if (/^[A-Za-z]:\\/.test(rawPath) || /^\\\\[^\\"'\s]+\\[^\\"'\s]+/.test(rawPath)) {
              projectWinPath = rawPath;
              const converted = await winToWslAsync(rawPath);
              if (converted && converted.startsWith('/')) wslPathCandidate = converted;
            } else {
              await writeDbg(`[WSL] skip unmatched rawPath='${rawPath}' file='${jf}'`);
              continue;
            }
            await writeDbg(`[WSL] file='${jf}' raw='${cwdMatch[1]}' norm='${rawPath}' win='${projectWinPath || ''}' wsl='${wslPathCandidate || ''}'`);
            let cleanWin = (projectWinPath || '').split(/<|\n/)[0].trim().replace(/\\n/g, '');
            let cleanWsl = (wslPathCandidate || '').split(/<|\n/)[0].trim().replace(/\\n/g, '');
            const projectDir = cleanWin || cleanWsl;
            if (!projectDir) continue;
            const projectName = path.basename(cleanWsl || cleanWin).replace(/\\n/g, '').trim();
            if (!sessionProjects.find((p) => p.winPath === projectDir || p.wslPath === cleanWsl)) {
              sessionProjects.push({ id: uid(), name: projectName || path.basename(projectDir), winPath: projectDir, wslPath: cleanWsl || '', hasDotCodex: false, createdAt: Date.now() });
              await writeDbg(`[WSL] add project name='${projectName}' win='${projectDir}' wsl='${cleanWsl}'`);
            }
          }
        } catch { continue; }
      }
    }
    if (sessionProjects.length > 0) {
      await writeLog(`sessionProjects found: ${sessionProjects.length}`);
      await writeDbg(`[WSL] sessionProjects=${sessionProjects.length}`);
      // 暂不返回；继续尝试补充 Windows 本机 sessions，之后统一早返回
    }
  } catch {}

  // 进一步：从 Windows 用户目录 ~/.codex/sessions 反向映射项目
  try {
    const winSessions = path.join(os.homedir(), '.codex', 'sessions');
    await writeDbg(`[WIN] sessionsRoot='${winSessions}'`);
    const years = await fsp.readdir(winSessions, { withFileTypes: true }).then((ds) => ds.filter((x) => x.isDirectory()).map((x) => x.name)).catch(() => [] as string[]);
    for (const y of years) {
      const monthsRoot = path.join(winSessions, y);
      const months = await fsp.readdir(monthsRoot, { withFileTypes: true }).then((ds) => ds.filter((x) => x.isDirectory()).map((x) => x.name)).catch(() => [] as string[]);
      for (const m of months) {
        const daysRoot = path.join(monthsRoot, m);
        const days = await fsp.readdir(daysRoot, { withFileTypes: true }).then((ds) => ds.filter((x) => x.isDirectory()).map((x) => x.name)).catch(() => [] as string[]);
        for (const dday of days) {
          const filesRoot = path.join(daysRoot, dday);
          const files = await fsp.readdir(filesRoot).then((fs) => fs.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
          await writeDbg(`[WIN] dir='${filesRoot}' files=${files.length}`);
          for (const f of files) {
            const fp = path.join(filesRoot, f);
            try {
              const content = await fsp.readFile(fp, 'utf8').catch(() => '');
              if (!content) continue;
              let cwdMatch = content.match(/Current working directory:\s*(.+?)(?:\r?\n|\\n|$)/i) || content.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
              if (cwdMatch && cwdMatch[1]) {
                let rawPath = cwdMatch[1]
                  .trim()
                  .replace(/^"|"$/g, '')
                  .split(/\\n|\r?\n/)[0]
                  .trim()
                  .replace(/\\+$/g, '')
                  .replace(/\\\\/g, '\\');
                let projectWinPath: string | undefined = undefined;
                let wslPathCandidate: string | undefined = undefined;
                if (/^[A-Za-z]:\\/.test(rawPath) || /^\\\\[^\\"'\s]+\\[^\\"'\s]+/.test(rawPath)) {
                  projectWinPath = rawPath;
                  const converted = await winToWslAsync(rawPath);
                  if (converted && converted.startsWith('/')) wslPathCandidate = converted;
                } else if (/^\//.test(rawPath)) {
                  const mnt = rawPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
                  if (mnt) projectWinPath = `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`;
                  wslPathCandidate = rawPath;
                }
                await writeDbg(`[WIN] file='${fp}' raw='${cwdMatch[1]}' norm='${rawPath}' win='${projectWinPath || ''}' wsl='${wslPathCandidate || ''}'`);
                const cleanWin = (projectWinPath || '').replace(/\\n/g, '').split(/<|\n/)[0].trim();
                const cleanWsl = (wslPathCandidate || '').replace(/\\n/g, '').split(/<|\n/)[0].trim();
                const projectDir = cleanWin || cleanWsl;
                if (!projectDir) continue;
                const name = path.basename(cleanWsl || cleanWin).trim();
                if (!sessionProjects.find((p) => p.winPath === projectDir || p.wslPath === cleanWsl)) {
                  sessionProjects.push({ id: uid(), name: name || path.basename(projectDir), winPath: projectDir, wslPath: cleanWsl || '', hasDotCodex: false, createdAt: Date.now() });
                  await writeDbg(`[WIN] add project name='${name}' win='${projectDir}' wsl='${cleanWsl}'`);
                }
              }
            } catch {}
          }
        }
      }
    }
  } catch {}

  // 如果通过 WSL 或 Windows 的 sessions 已经反推出项目，按“会话即真相”直接返回，避免引入无历史的目录
  if (sessionProjects.length > 0) {
    try { await saveStoreAsync(sessionProjects); } catch {}
    await writeDbg(`[RETURN] by sessions count=${sessionProjects.length}`);
    return sessionProjects;
  }

  // Fast-path: if roots & session signatures equal to meta and we already have store, skip heavy rescans
  try {
    const curRoots: string[] = (roots && roots.length)
      ? roots.slice().map((r) => (r ? r.replace(/^@+\\?\\?/, '').replace(/^@+\//, '') : r))
      : (await (async () => {
          try { const def = await getDefaultRootsAsync(); return Array.isArray(def) && def.length ? def : [path.join(os.homedir(), 'code')]; }
          catch { return [path.join(os.homedir(), 'code')]; }
        })());
    const rootSigs = await Promise.all(curRoots.map((r) => computeRootMetaSig(r)));
    // session roots: all distros' ~/.codex/sessions (UNC)
    const sessionRoots: string[] = await (async () => {
      const out: string[] = [];
      try {
        const distros = await listDistrosAsync();
        for (const d of distros) {
          const home = await getDistroHomeAsync(d.name);
          if (!home) continue;
          out.push(path.join(wslToUNC(home, d.name), '.codex', 'sessions'));
        }
      } catch {}
      return out;
    })();
    const sessionSigs = await Promise.all(sessionRoots.map((r) => computeSessionRootSig(r)));
    const meta = loadScanMeta();
    const storeNow = loadStore();
    if (meta && storeNow && storeNow.length > 0 && sameRootSigs(rootSigs, meta.rootSigs || []) && sameSessionSigs(sessionSigs, meta.sessionSigs || [])) {
      return storeNow;
    }
  } catch {}

  if (roots && roots.length) {
    rootsToScan = roots.slice().map((r) => (r ? r.replace(/^@+\\?\\?/, '').replace(/^@+\//, '') : r));
  } else {
    try {
      const def = await getDefaultRootsAsync();
      if (Array.isArray(def) && def.length > 0) rootsToScan.push(...def);
      else rootsToScan.push(path.join(os.homedir(), 'code'));
    } catch {
      rootsToScan.push(path.join(os.homedir(), 'code'));
    }
  }
  await writeDbg(`[ROOTS] scan roots=${JSON.stringify(rootsToScan)}`);

  const found: Project[] = [...sessionProjects];
  const sanitize = (p: string) => (p ? p.replace(/^@+/, '').replace(/^\\+/, '\\').replace(/^\/+/, '') : p);

  for (let r of rootsToScan) {
    r = sanitize(r || '');
    try {
      if (!r) continue;
      if (!(await pathExists(r))) continue;
      if (!(await statIsDir(r))) continue;
      const entries = await fsp.readdir(r, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const winPath = path.join(r, e.name);
        let wslPath = await winToWslAsync(winPath);
        if (isUNCPath(winPath)) {
          const u = uncToWsl(winPath);
          if (u) wslPath = u.wslPath;
        }
        const dotcodex1 = path.join(winPath, '.codex');
        const dotcodex2 = path.join(winPath, 'codex.json');
        const hasDot = (await pathExists(dotcodex1)) || (await pathExists(dotcodex2));
        const existing = (found.find((s) => s.winPath === winPath || s.wslPath === wslPath)) || store.find((s) => s.winPath === winPath || s.wslPath === wslPath);
        let proj: Project;
        if (existing) {
          proj = { ...existing, hasDotCodex: hasDot };
        } else {
          proj = {
            id: uid(),
            name: e.name,
            winPath,
            wslPath,
            hasDotCodex: hasDot,
            createdAt: Date.now(),
            lastOpenedAt: undefined,
          };
        }
        if (!found.find((f) => f.winPath === proj.winPath || f.wslPath === proj.wslPath)) {
          found.push(proj);
          await writeDbg(`[SCAN] add from root='${r}' name='${proj.name}' win='${proj.winPath}' wsl='${proj.wslPath}' dot=${proj.hasDotCodex}`);
        }
      }
    } catch {
      continue;
    }
  }

  // 辅助索引：从 WSL ~/.codex/sessions 反向映射
  try {
    const distros = await listDistrosAsync();
    for (const d of distros) {
      const home = await getDistroHomeAsync(d.name);
      if (!home) continue;
      let sessionsRoot = path.join(wslToUNC(home, d.name), '.codex', 'sessions');
      sessionsRoot = sanitize(sessionsRoot);
      let exists = await pathExists(sessionsRoot);
      if (!exists) {
        try {
          const listing = await execInWslAsync(d.name, `ls -A "${home}/.codex/sessions" 2>/dev/null || true`);
          if (!listing) continue;
        } catch { continue; }
      }
      const years = await fsp.readdir(sessionsRoot, { withFileTypes: true }).then((ds) => ds.filter((x) => x.isDirectory()).map((x) => x.name)).catch(() => [] as string[]);
      for (const y of years) {
        const monthsRoot = path.join(sessionsRoot, y);
        const months = await fsp.readdir(monthsRoot, { withFileTypes: true }).then((ds) => ds.filter((x) => x.isDirectory()).map((x) => x.name)).catch(() => [] as string[]);
        for (const m of months) {
          const daysRoot = path.join(monthsRoot, m);
          const days = await fsp.readdir(daysRoot, { withFileTypes: true }).then((ds) => ds.filter((x) => x.isDirectory()).map((x) => x.name)).catch(() => [] as string[]);
          for (const dday of days) {
            const filesRoot = path.join(daysRoot, dday);
            const files = await fsp.readdir(filesRoot).then((fs) => fs.filter((f) => f.endsWith('.jsonl'))).catch(() => [] as string[]);
            for (const f of files) {
              const fp = path.join(filesRoot, f);
              try {
                let firstLine = '';
                try {
                  const relPath = fp.replace(/^\\\\wsl\.localhost\\[^\\]+\\/, '/');
                  const content = await readFileInWslAsync(d.name, relPath);
                  if (content) firstLine = content.split(/\r?\n/).find(Boolean) || '';
                } catch {
                  try { firstLine = await fsp.readFile(fp, 'utf8').then((s) => s.split(/\r?\n/).find(Boolean) || ''); } catch { firstLine = ''; }
                }
                let parsed: any = null;
                try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
                const candidates: string[] = [];
                if (parsed) {
                  if (parsed.cwd) candidates.push(parsed.cwd);
                  if (parsed.working_dir) candidates.push(parsed.working_dir);
                  if (parsed.git && parsed.git.repo) candidates.push(parsed.git.repo);
                  // 不将 instructions 纳入候选，避免将自然语言误识别为路径
                }
                // 仅提取高置信度路径：/mnt/<drv>/..., /home/..., Windows 盘符 或 UNC 到 wsl.localhost
                const textScan = (firstLine || '');
                const strictRegex = /(\/mnt\/[a-zA-Z]\/[^\s\"']+|\/home\/[^^\s\"']+|[A-Za-z]:\\[^\s\"']+|\\\\\\\\wsl\.localhost\\\\[^\\]+\\\\[^\s\"']+)/g;
                let mexec: RegExpExecArray | null;
                while ((mexec = strictRegex.exec(textScan))) {
                  candidates.push(mexec[0]);
                }
                for (const c of candidates) {
                  let projectDir = '';
                  let wslPathCandidate = '';
                  if (/^\//.test(c)) { wslPathCandidate = c; projectDir = wslToUNC(c, d.name); }
                  else if (/^[A-Za-z]:\\/.test(c) || /^\\\\\\\\/.test(c)) { projectDir = c; wslPathCandidate = await winToWslAsync(c); }
                  else continue;
                  const projectName = path.basename(wslPathCandidate || projectDir);
                  if (projectDir && !found.find((x) => x.winPath === projectDir || x.wslPath === wslPathCandidate)) {
                    found.push({
                      id: uid(),
                      name: projectName,
                      winPath: projectDir,
                      wslPath: wslPathCandidate,
                      hasDotCodex: (await pathExists(path.join(projectDir, '.codex'))) || (await pathExists(path.join(projectDir, 'codex.json'))),
                      createdAt: Date.now(),
                    });
                  }
                }
              } catch { continue; }
            }
          }
        }
      }
    }
  } catch {}

  // 合并 store 中仍存在的项目
  for (const s of store) {
    try {
      if (s.winPath && (await pathExists(s.winPath))) {
        if (!found.find((f) => f.winPath === s.winPath)) found.push(s);
      } else if (s.wslPath) {
        const checkWin = wslToUNC(s.wslPath);
        if (checkWin && (await pathExists(checkWin))) {
          if (!found.find((f) => f.wslPath === s.wslPath)) found.push(s);
        }
      }
    } catch {}
  }

  // 去重合并：同一目录（WSL 规范化路径）视为同一个项目
  const canon = async (p: Project): Promise<string> => {
    try {
      if (p.wslPath && p.wslPath.startsWith('/')) return p.wslPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      if (isUNCPath(p.winPath)) {
        const u = uncToWsl(p.winPath);
        if (u) return u.wslPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      }
      const w = await winToWslAsync(p.winPath);
      if (w) return w.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    } catch {}
    // 回退：用 winPath 标准化
    return p.winPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  };
  const mergedMap = new Map<string, Project>();
  for (const p of found) {
    const key = await canon(p);
    const prev = mergedMap.get(key);
    if (!prev) {
      mergedMap.set(key, p);
    } else {
      // 合并：保留更早创建时间的 id/name，补充缺失的路径与标志
      const keep = prev.createdAt <= p.createdAt ? prev : p;
      const other = keep === prev ? p : prev;
      keep.hasDotCodex = keep.hasDotCodex || other.hasDotCodex;
      if (!keep.wslPath && other.wslPath) keep.wslPath = other.wslPath;
      if (!keep.winPath && other.winPath) keep.winPath = other.winPath;
      if (!keep.name && other.name) keep.name = other.name;
      mergedMap.set(key, keep);
    }
  }
  const unique = Array.from(mergedMap.values());
  await saveStoreAsync(unique);
  await writeDbg(`[DONE] total projects=${unique.length}`);
  // persist meta for fast-path on next run
  try {
    const rootSigs = await Promise.all(rootsToScan.map((r) => computeRootMetaSig(r)));
    const sessionRoots: string[] = await (async () => {
      const out: string[] = [];
      try {
        const distros = await listDistrosAsync();
        for (const d of distros) {
          const home = await getDistroHomeAsync(d.name);
          if (!home) continue;
          out.push(path.join(wslToUNC(home, d.name), '.codex', 'sessions'));
        }
      } catch {}
      return out;
    })();
    const sessionSigs = await Promise.all(sessionRoots.map((r) => computeSessionRootSig(r)));
    saveScanMeta({ roots: rootsToScan, rootSigs, sessionSigs, savedAt: Date.now() });
  } catch {}
  return unique;
}

export function addProjectByWinPath(winPath: string): Project | null {
  try {
    const normalized = path.resolve(winPath);
    const wslPath = winToWsl(normalized);
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
  } catch (e) {
    return null;
  }
}

export function touchProject(id: string) {
  const store = loadStore();
  const p = store.find((s) => s.id === id);
  if (p) {
    p.lastOpenedAt = Date.now();
    saveStore(store);
  }
}

export default { scanProjectsAsync, addProjectByWinPath, touchProject };
