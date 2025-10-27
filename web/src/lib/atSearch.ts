// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AtCategory, AtCategoryId, AtItem, FileItem, RuleItem, SearchResult, SearchScope } from "@/types/at";
import type { FileCandidate } from "@/lib/fileIndexClient";
import { ensureIndex as ensureIdx, getAllCandidates } from "@/lib/fileIndexClient";

// 分类常量（保持不变）
export const AT_CATEGORIES: AtCategory[] = [
  { id: "files", name: "Files & Folders", icon: "FolderOpenDot" },
  { id: "rule", name: "Rules", icon: "ScrollText" },
];

const SPECIAL_RULE_FILES = [
  { rel: ".cursor/index.mdc", group: "项目常驻" },
  { rel: ".cursorrules", group: "旧版兼容" },
];

// Worker 管理（懒加载）
let worker: Worker | null = null;
let workerLoaded = false;
let currentRoot: string | null = null; // 当前项目根（Windows/UNC）
let workerRoot: string | null = null;  // Worker 内当前已加载的根
const cacheByRoot = new Map<string, FileCandidate[]>();
const loadingByRoot = new Map<string, Promise<FileCandidate[]>>();
const cacheIndexByRoot = new Map<string, Map<string, FileCandidate>>(); // key: D:/F:+rel
let subscribed = false; // 渲染进程仅订阅一次主进程的索引变更事件

// 前端调试日志：读取统一调试配置（preload 注入只读缓存）
function dbgEnabled(): boolean {
  try { return !!(globalThis as any).__cf_at_debug__; } catch { return false; }
}
function perfLog(msg: string) {
  if (!dbgEnabled()) return;
  const line = `[atSearch] ${msg}`;
  try { (window as any).host?.utils?.perfLog?.(line); } catch {}
  try { console.debug(line); } catch {}
}

function toPosixRel(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

function buildRuleItem(rel: string, group?: string): RuleItem {
  const posix = toPosixRel(rel);
  const idx = posix.lastIndexOf("/");
  const baseName = idx >= 0 ? posix.slice(idx + 1) : posix;
  const title = baseName || posix;
  const subtitle = group ? `${group} · ${posix}` : posix;
  return {
    id: `rule:${posix}`,
    categoryId: "rule",
    title,
    subtitle,
    group,
    path: posix,
    icon: "ScrollText",
  };
}

function buildRuleItemsFromCandidates(list: FileCandidate[]): RuleItem[] {
  const items: RuleItem[] = [];
  const byRel = new Map<string, FileCandidate>();
  for (const cand of list) {
    if (!cand || cand.isDir) continue;
    const rel = toPosixRel(cand.rel);
    if (!rel) continue;
    byRel.set(rel, cand);
  }

  for (const spec of SPECIAL_RULE_FILES) {
    const rel = toPosixRel(spec.rel);
    if (!rel) continue;
    if (byRel.has(rel)) {
      items.push(buildRuleItem(rel, spec.group));
    }
  }

  const dynamic: string[] = [];
  for (const rel of byRel.keys()) {
    if (rel.startsWith(".cursor/rules/") && rel.endsWith(".mdc")) dynamic.push(rel);
  }
  dynamic.sort((a, b) => a.localeCompare(b));
  for (const rel of dynamic) {
    items.push(buildRuleItem(rel, "按场景动态"));
  }
  return items;
}

function ensureWorker(): Worker {
  if (!worker) {
    // Vite 友好写法（module worker）
    worker = new Worker(new URL("./atWorker.ts", import.meta.url), { type: "module" });
    workerLoaded = false;
    worker.onmessage = (ev: MessageEvent) => {
      const data: any = ev.data || {};
      if (data && data.type === 'loaded') {
        workerLoaded = true;
        perfLog(`worker.loaded total=${data.total} root='${workerRoot || ''}'`);
      }
    };
  }
  return worker;
}

function toFileItem(rel: string, isDir: boolean, idx: number): FileItem {
  const norm = String(rel || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  const base = i >= 0 ? norm.slice(i + 1) : norm;
  return {
    id: `f-${idx}-${norm}`,
    categoryId: "files",
    title: base || norm,
    subtitle: norm, // 用相对路径展示
    path: norm,     // 用于携带相对路径（拼接时使用）
    isDir,
    icon: isDir ? "FolderOpenDot" : "FileText",
  };
}

async function loadCandidatesForRoot(root: string, excludes?: string[]): Promise<FileCandidate[]> {
  const key = String(root || '').toLowerCase();
  if (cacheByRoot.has(key)) return cacheByRoot.get(key)!;
  if (loadingByRoot.has(key)) return loadingByRoot.get(key)!;
  const p = (async () => {
    const t0 = Date.now();
    perfLog(`ensureIndex.start root='${root}'`);
    await ensureIdx(root, excludes);
    perfLog(`ensureIndex.done root='${root}' dur=${Date.now() - t0}ms`);
    const t1 = Date.now();
    const list = await getAllCandidates(root);
    perfLog(`candidates.loaded root='${root}' count=${list.length} dur=${Date.now() - t1}ms`);
    cacheByRoot.set(key, list);
    try {
      const idx = new Map<string, FileCandidate>();
      for (const it of list) idx.set(`${it.isDir ? 'D' : 'F'}:${it.rel}`, it);
      cacheIndexByRoot.set(key, idx);
    } catch {}
    loadingByRoot.delete(key);
    return list;
  })();
  loadingByRoot.set(key, p);
  return p;
}

function postToWorkerForRoot(root: string, list: FileCandidate[]) {
  ensureWorker();
  try { worker?.postMessage({ type: 'load', candidates: list }); workerRoot = root; perfLog(`worker.load root='${root}' count=${list.length}`); } catch {}
}

export async function setActiveFileIndexRoot(winRoot: string, excludes?: string[]): Promise<void> {
  currentRoot = winRoot;
  // 切换项目时：通知主进程仅保留当前根的 watcher，避免多项目同时监听带来的负载
  try { await (window as any).host?.fileIndex?.setActiveRoots?.([winRoot]); } catch {}
  // 首次调用时订阅主进程的索引变更事件
  if (!subscribed) {
    try {
      const onChanged = (window as any).host?.fileIndex?.onChanged;
      if (typeof onChanged === 'function') {
        onChanged(async ({ root, adds, removes }: { root: string; adds?: { rel: string; isDir: boolean }[]; removes?: { rel: string; isDir: boolean }[] }) => {
          try {
            if (!root || !currentRoot) return;
            if (String(root).toLowerCase() !== String(currentRoot).toLowerCase()) return;
            const key = String(currentRoot || '').toLowerCase();
            const hasPatch = (Array.isArray(adds) && adds.length > 0) || (Array.isArray(removes) && removes.length > 0);
            if (hasPatch) {
              const list = cacheByRoot.get(key) || [];
              const idx = cacheIndexByRoot.get(key) || new Map<string, FileCandidate>();
              const addsList = Array.isArray(adds) ? adds : [];
              const removesList = Array.isArray(removes) ? removes : [];
              let changed = false;
              // 应用新增
              for (const a of addsList) {
                const k = `${a.isDir ? 'D' : 'F'}:${a.rel}`;
                if (!idx.has(k)) { const it = { rel: a.rel, isDir: !!a.isDir } as FileCandidate; idx.set(k, it); list.push(it); changed = true; }
              }
              // 应用删除（批量过滤更快）
              if (removesList.length > 0 && list.length > 0) {
                const rm = new Set(removesList.map(r => `${r.isDir ? 'D' : 'F'}:${r.rel}`));
                if (rm.size > 0) {
                  const kept: FileCandidate[] = [];
                  for (const it of list) { const k = `${it.isDir ? 'D' : 'F'}:${it.rel}`; if (!rm.has(k)) kept.push(it); }
                  if (kept.length !== list.length) {
                    cacheByRoot.set(key, kept);
                    const idx2 = new Map<string, FileCandidate>(); for (const it of kept) idx2.set(`${it.isDir ? 'D' : 'F'}:${it.rel}`, it);
                    cacheIndexByRoot.set(key, idx2);
                  } else {
                    cacheByRoot.set(key, list);
                    cacheIndexByRoot.set(key, idx);
                  }
                  changed = true;
                }
              } else {
                cacheByRoot.set(key, list);
                cacheIndexByRoot.set(key, idx);
              }
              if (changed) {
                ensureWorker();
                try { worker?.postMessage({ type: 'patch', adds: addsList, removes: removesList }); } catch {}
                try { await (window as any).host?.utils?.perfLog?.(`[atSearch] patched root='${currentRoot}' adds=${addsList.length} removes=${removesList.length} total=${(cacheByRoot.get(key) || []).length}`); } catch {}
              }
            } else {
              // 兼容兜底：全量刷新（避免极端情况下 patch 丢失）
              try { await (window as any).host?.utils?.perfLog?.(`[atSearch] onChanged(root-only) root='${root}' current='${currentRoot}'`); } catch {}
              const list = await getAllCandidates(currentRoot).catch(() => [] as FileCandidate[]);
              cacheByRoot.set(key, list);
              const idx = new Map<string, FileCandidate>(); for (const it of list) idx.set(`${it.isDir ? 'D' : 'F'}:${it.rel}`, it);
              cacheIndexByRoot.set(key, idx);
              postToWorkerForRoot(currentRoot, list);
            }
            const total = (cacheByRoot.get(key) || []).length;
            perfLog(`renderer.refresh root='${currentRoot}' count=${total}`);
          } catch {}
        });
        try { await (window as any).host?.utils?.perfLog?.(`[atSearch] subscribed.onChanged`); } catch {}
        subscribed = true;
      }
    } catch {}
  }
  // 大仓库卡顿优化：不在“选中项目”时预加载所有候选，等首次 @ 查询再懒加载
  try {
    const key = String(winRoot || '').toLowerCase();
    const cached = cacheByRoot.get(key);
    if (cached && cached.length > 0) {
      postToWorkerForRoot(winRoot, cached);
    }
  } catch {}
}

function normalize(s: string): string { return String(s || "").replace(/\\/g, "/").toLowerCase(); }

function scoreRule(item: RuleItem, query: string): number {
  const t = normalize(item.title);
  const g = normalize(item.subtitle || "");
  const q = normalize(query);
  let s = 0;
  if (!q) return 0;
  if (t.startsWith(q)) s += 800;
  if (t.includes(q)) s += 300;
  if (g.startsWith(q)) s += 200;
  if (g.includes(q)) s += 100;
  return s;
}

// 使用 Worker 执行文件匹配；若 Worker 未就绪，回退到主线程简易匹配（保证同步体验）
export async function searchAtItems(query: string, scope: SearchScope, limit = 30): Promise<SearchResult[]> {
  const q = String(query || "").trim();
  const results: SearchResult[] = [];

  // 规则类：从候选文件中过滤 .cursor 相关规则文件
  const pickRules = async () => {
    if (scope !== 'all' && scope !== 'rule') return;
    if (!currentRoot) return;
    const rootKey = String(currentRoot || '').toLowerCase();
    let candidates = cacheByRoot.get(rootKey);
    if (!candidates) {
      candidates = await loadCandidatesForRoot(currentRoot).catch(() => [] as FileCandidate[]);
    }
    const rules = buildRuleItemsFromCandidates(candidates || []);
    if (rules.length === 0) return;
    if (!q) {
      for (const it of rules.slice(0, Math.min(10, Math.max(0, limit - results.length)))) results.push({ item: it, score: 0 });
      return;
    }
    const scored = rules.map((it) => ({ item: it as AtItem, score: scoreRule(it, q) }));
    scored.sort((a, b) => b.score - a.score);
    for (const it of scored.slice(0, Math.max(0, limit - results.length))) results.push(it);
  };

  // 文件类：优先使用 Worker；若未就绪则用本地候选简易匹配
  const pickFiles = async () => {
    if (scope !== 'all' && scope !== 'files') return;
    if (!currentRoot) return;
    // 确保 Worker 已加载当前根的候选（若未就绪则先加载并推送）
    if (workerRoot !== currentRoot) {
      const list = await loadCandidatesForRoot(currentRoot).catch(() => [] as FileCandidate[]);
      if (workerRoot !== currentRoot) postToWorkerForRoot(currentRoot, list);
    }
    const want = Math.min(30, limit);
    const w = ensureWorker();
    const t0 = Date.now();
    const workerPromise = new Promise<{ rel: string; isDir: boolean; score: number }[]>((resolve) => {
      const handler = (ev: MessageEvent) => {
        const data: any = ev.data || {};
        if (data && data.type === 'result' && String(data.q) === q) {
          try { w.removeEventListener('message', handler as any); } catch {}
          resolve(Array.isArray(data.items) ? data.items : []);
        }
      };
      w.addEventListener('message', handler as any, { once: false });
      try { w.postMessage({ type: 'query', q, limit: want }); } catch { resolve([]); }
    });

    // 根据候选规模动态等待更长时间，避免大仓库过早超时导致 0 结果
    const rootKey = String(currentRoot || '').toLowerCase();
    const localAll = cacheByRoot.get(rootKey) || [];
    const waitMs = localAll.length > 100000 ? 350 : localAll.length > 30000 ? 200 : 60;
    let ranked = await Promise.race([
      workerPromise,
      new Promise<any[]>((resolve) => setTimeout(() => resolve([]), waitMs)),
    ]);

    if ((!ranked || ranked.length === 0)) {
      // Worker 尚未加载完成或空查询：回退到本地候选（不阻塞 UI）
      const local = localAll;
      if (!q) {
        ranked = local.slice(0, want).map(it => ({ rel: it.rel, isDir: it.isDir, score: 0 }));
      } else {
        const nn = normalize(q);
        const scored = local.map((it, i) => {
          const relNorm = normalize(it.rel);
          let s = 0;
          if (relNorm.startsWith(nn)) s += 900;
          if (relNorm.includes(nn)) s += 300;
          if (nn.includes('/')) { if (it.isDir) s += 120; }
          s -= it.rel.length * 0.3;
          return { rel: it.rel, isDir: it.isDir, score: s, _i: i } as any;
        }).sort((a, b) => b.score - a.score).slice(0, want).map(x => ({ rel: x.rel, isDir: x.isDir, score: x.score }));
        ranked = scored;
      }
      perfLog(`search.fallback root='${currentRoot}' q='${q}' localCount=${local.length} res=${ranked.length} waitMs=${waitMs}`);
    }

    // 转为 AtItem
    const items: FileItem[] = ranked.map((r, i) => toFileItem(r.rel, r.isDir, i));
    perfLog(`search.worker root='${currentRoot}' q='${q}' res=${ranked.length} dur=${Date.now() - t0}ms`);
    for (const it of items) results.push({ item: it as AtItem, score: 0 });
  };

  if (!q) {
    await pickFiles();
    await pickRules();
    return results.slice(0, limit);
  }

  await pickFiles();
  await pickRules();
  perfLog(`search.done root='${currentRoot}' q='${q}' scope='${scope}' total=${results.length}`);
  return results.slice(0, limit);
}

export function getCategoryById(id: AtCategoryId): AtCategory | undefined {
  return AT_CATEGORIES.find((c) => c.id === id);
}
