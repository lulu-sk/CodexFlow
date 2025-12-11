// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AtCategory, AtCategoryId, AtItem, FileItem, RuleItem, SearchResult, SearchScope } from "@/types/at";
import type { FileCandidate } from "@/lib/fileIndexClient";
import { ensureIndex as ensureIdx, getAllCandidates } from "@/lib/fileIndexClient";
import i18n from "@/i18n/setup";

// 分类常量（保持不变）
export const AT_CATEGORIES: AtCategory[] = [
  { id: "files", name: "Files & Folders", icon: "FolderOpenDot" },
  { id: "rule", name: "Rules", icon: "ScrollText" },
];

const SPECIAL_RULE_FILES: Array<{ rel: string; groupKey: "pinned" | "legacy" }> = [
  { rel: ".cursor/index.mdc", groupKey: "pinned" },
  { rel: ".cursorrules", groupKey: "legacy" },
];

// Worker 管理（懒加载）
let worker: Worker | null = null;
let workerLoaded = false;
let currentRoot: string | null = null; // 当前项目根（Windows/UNC）
let workerRoot: string | null = null;  // Worker 内当前已加载的根
let lastActiveRoot: string | null = null; // 最近一次激活的项目根（用于后台清理后的恢复）
let restoreActiveRootPromise: Promise<void> | null = null; // 控制并发恢复，避免竞争
const cacheByRoot = new Map<string, FileCandidate[]>();
const loadingByRoot = new Map<string, Promise<FileCandidate[]>>();
const cacheIndexByRoot = new Map<string, Map<string, FileCandidate>>(); // key: D:/F:+rel
let subscribed = false; // 渲染进程仅订阅一次主进程的索引变更事件

// Worker 生命周期清理：在窗口卸载时主动终止，避免浏览器保留线程对象导致的极小概率残留
let workerCleanupInstalled = false;
function disposeWorker(): void {
  try {
    // 先移除回调，打断潜在闭包引用链，便于 GC 回收
    try { if (worker) (worker as any).onmessage = null; } catch {}
    try { if (worker) (worker as any).onmessageerror = null; } catch {}
    try { if (worker) (worker as any).onerror = null; } catch {}
    try { worker?.terminate(); } catch {}
  } catch {}
  worker = null;
  workerLoaded = false;
  workerRoot = null;
}
function ensureWorkerCleanupHook(): void {
  if (typeof window === "undefined") return;
  if (workerCleanupInstalled) return;
  try {
    window.addEventListener("beforeunload", () => {
      try { cleanupRendererResources("unload"); } catch {}
    });
    window.addEventListener("visibilitychange", () => {
      try {
        if (typeof document !== "undefined" && document.hidden) {
          scheduleHiddenCleanup();
        } else {
          clearHiddenCleanupTimer();
          touchAtUsage(); // 回到前台时延长空闲计时，避免频繁重建索引
          // 若后台清理已释放索引，恢复最近的项目根，避免回到前台后 @ 面板为空
          restoreActiveRootIfCleared("visible").catch(() => {});
        }
      } catch {}
    });
    workerCleanupInstalled = true;
  } catch {}
}

const MAX_CACHE_ROOTS = 3; // 缓存根目录数量上限，收紧多仓缓存占用
const KEY_PREFIX_DIR = "D";
const KEY_PREFIX_FILE = "F";
const IDLE_DISPOSE_MS = 3 * 60 * 1000; // @ 面板空闲超时回收（ms）
const HIDDEN_DISPOSE_MS = 90 * 1000; // 页面隐藏后延迟释放资源（ms）
let idleTimer: number | null = null;
let hiddenCleanupTimer: number | null = null;
const loadGenByRoot = new Map<string, number>(); // 用于防止被清理后的旧异步加载回写缓存，并维护代际号

function normalizeRootKey(root: string | null | undefined): string {
  return String(root || "").toLowerCase();
}

function isSameRoot(a?: string | null, b?: string | null): boolean {
  return normalizeRootKey(a) === normalizeRootKey(b);
}

function buildIndexFor(list: FileCandidate[]): Map<string, FileCandidate> {
  const idx = new Map<string, FileCandidate>();
  for (const item of list) {
    idx.set(`${item.isDir ? KEY_PREFIX_DIR : KEY_PREFIX_FILE}:${item.rel}`, item);
  }
  return idx;
}

function enforceCacheLimit(preserveKey?: string): void {
  if (cacheByRoot.size <= MAX_CACHE_ROOTS) return;
  const currentKey = currentRoot ? normalizeRootKey(currentRoot) : null;
  const keep = new Set<string>();
  if (preserveKey) keep.add(preserveKey);
  if (currentKey) keep.add(currentKey);
  let trimmed = false;
  for (const key of Array.from(cacheByRoot.keys())) {
    if (cacheByRoot.size <= MAX_CACHE_ROOTS) break;
    if (keep.has(key)) continue;
    invalidateRendererRoot(key);
    trimmed = true;
    if (workerRoot && normalizeRootKey(workerRoot) === key) {
      workerRoot = null;
      workerLoaded = false;
    }
  }
  // 若发生裁剪，顺带清理已失效根的代际计数，避免 Map 长期增长
  if (trimmed) pruneLoadGenerations(preserveKey ?? currentRoot);
}

function bumpLoadGeneration(key: string): number {
  const next = (loadGenByRoot.get(key) ?? 0) + 1;
  loadGenByRoot.set(key, next);
  return next;
}

function invalidateRendererRoot(key: string): void {
  cacheByRoot.delete(key);
  cacheIndexByRoot.delete(key);
  loadingByRoot.delete(key);
  bumpLoadGeneration(key);
}

function trimRendererCaches(keepRoot?: string | null): void {
  const keepKey = keepRoot ? normalizeRootKey(keepRoot) : null;
  for (const key of Array.from(cacheByRoot.keys())) {
    if (keepKey && key === keepKey) continue;
    invalidateRendererRoot(key);
  }
  for (const key of Array.from(loadingByRoot.keys())) {
    if (keepKey && key === keepKey) continue;
    invalidateRendererRoot(key);
  }
  enforceCacheLimit(keepKey ?? undefined);
  pruneLoadGenerations(keepRoot);
}

// 清理已被裁剪的根对应的 load 代际，避免 Map 无限增长
function pruneLoadGenerations(keepRoot?: string | null): void {
  const keepKey = keepRoot ? normalizeRootKey(keepRoot) : null;
  const alive = new Set<string>();
  if (keepKey) alive.add(keepKey);
  if (currentRoot) alive.add(normalizeRootKey(currentRoot));
  if (workerRoot) alive.add(normalizeRootKey(workerRoot));
  for (const k of cacheByRoot.keys()) alive.add(k);
  for (const k of loadingByRoot.keys()) alive.add(k);
  for (const k of Array.from(loadGenByRoot.keys())) {
    if (!alive.has(k)) loadGenByRoot.delete(k);
  }
}

function cleanupRendererResources(reason?: string): void {
  const prevRoot = currentRoot;
  if (prevRoot) lastActiveRoot = prevRoot; // 记录最近活跃根，便于恢复
  try { disposeWorker(); } catch {}
  // 清理所有缓存（包含当前根），避免在主进程 watcher 已关闭时继续复用陈旧列表
  trimRendererCaches(null);
  if (typeof window !== "undefined" && idleTimer !== null) {
    try { window.clearTimeout(idleTimer); } catch {}
  }
  idleTimer = null;
  if (typeof window !== "undefined" && hiddenCleanupTimer !== null) {
    try { window.clearTimeout(hiddenCleanupTimer); } catch {}
  }
  hiddenCleanupTimer = null;
  currentRoot = null;
  workerRoot = null;
  workerLoaded = false;
  loadGenByRoot.clear();
  // 主进程同步收敛：释放 fileIndex watcher 与内存缓存，避免长期驻留
  try {
    const p = (window as any).host?.fileIndex?.setActiveRoots?.([]);
    // 捕获 Promise 拒绝，避免窗口关闭阶段出现未处理异常
    if (p && typeof (p as any).catch === "function") (p as Promise<unknown>).catch(() => {});
  } catch {}
  perfLog(`cleanup reason='${reason || 'idle'}' root='${prevRoot || ''}' caches=${cacheByRoot.size}`);
}

function touchAtUsage(): void {
  if (typeof window === "undefined") return;
  try { if (idleTimer !== null) window.clearTimeout(idleTimer); } catch {}
  idleTimer = window.setTimeout(() => cleanupRendererResources("idle"), IDLE_DISPOSE_MS);
  clearHiddenCleanupTimer();
}

function clearHiddenCleanupTimer(): void {
  if (typeof window === "undefined") return;
  if (hiddenCleanupTimer !== null) {
    try { window.clearTimeout(hiddenCleanupTimer); } catch {}
  }
  hiddenCleanupTimer = null;
}

function scheduleHiddenCleanup(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  clearHiddenCleanupTimer();
  try {
    if (!document.hidden) return;
    hiddenCleanupTimer = window.setTimeout(() => cleanupRendererResources("hidden"), HIDDEN_DISPOSE_MS);
  } catch {}
}

// 在被后台/空闲清理后，尝试自动恢复最近一次的项目根，减少首次搜索空结果
async function restoreActiveRootIfCleared(reason?: string): Promise<void> {
  if (currentRoot || !lastActiveRoot) return;
  if (restoreActiveRootPromise) {
    try { await restoreActiveRootPromise; } catch {}
    return;
  }
  const restoringRoot = lastActiveRoot;
  const p = (async () => {
    try {
      if (!restoringRoot || currentRoot) return;
      await setActiveFileIndexRoot(restoringRoot);
      perfLog(`restore.root reason='${reason || ''}' root='${restoringRoot || ''}'`);
    } catch {}
  })();
  restoreActiveRootPromise = p.finally(() => { restoreActiveRootPromise = null; });
  try { await restoreActiveRootPromise; } catch {}
}

function storeCacheEntry(rootKey: string, list: FileCandidate[], index?: Map<string, FileCandidate>): Map<string, FileCandidate> {
  const key = normalizeRootKey(rootKey);
  const idx = index ?? buildIndexFor(list);
  if (cacheByRoot.has(key)) cacheByRoot.delete(key);
  cacheByRoot.set(key, list);
  if (cacheIndexByRoot.has(key)) cacheIndexByRoot.delete(key);
  cacheIndexByRoot.set(key, idx);
  enforceCacheLimit(key);
  return idx;
}

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
      const group = i18n.t(`at:groups.${spec.groupKey}`) as string;
      items.push(buildRuleItem(rel, group));
    }
  }

  const dynamic: string[] = [];
  for (const rel of byRel.keys()) {
    if (rel.startsWith(".cursor/rules/") && rel.endsWith(".mdc")) dynamic.push(rel);
  }
  dynamic.sort((a, b) => a.localeCompare(b));
  for (const rel of dynamic) {
    items.push(buildRuleItem(rel, i18n.t("at:groups.dynamic") as string));
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
  // 确保仅安装一次卸载清理钩子
  ensureWorkerCleanupHook();
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
  const key = normalizeRootKey(root);
  if (cacheByRoot.has(key)) return cacheByRoot.get(key)!;
  if (loadingByRoot.has(key)) return loadingByRoot.get(key)!;
  const loadGen = bumpLoadGeneration(key); // 每次加载生成新的代际，便于在清理后阻止旧结果回写
  const p = (async () => {
    try {
      const t0 = Date.now();
      perfLog(`ensureIndex.start root='${root}'`);
      await ensureIdx(root, excludes);
      perfLog(`ensureIndex.done root='${root}' dur=${Date.now() - t0}ms`);
      const t1 = Date.now();
      const list = await getAllCandidates(root);
      perfLog(`candidates.loaded root='${root}' count=${list.length} dur=${Date.now() - t1}ms`);
      const idx = buildIndexFor(list);
      // 若在加载期间根被清理（如切换项目或 LRU 收缩），则跳过回写
      if ((loadGenByRoot.get(key) ?? 0) !== loadGen) {
        perfLog(`candidates.skip root='${root}' reason='invalidated'`);
        return list;
      }
      storeCacheEntry(root, list, idx);
      return list;
    } finally {
      loadingByRoot.delete(key);
    }
  })();
  loadingByRoot.set(key, p);
  return p;
}

function postToWorkerForRoot(root: string, list: FileCandidate[]) {
  ensureWorker();
  try { worker?.postMessage({ type: 'load', candidates: list }); workerRoot = root; perfLog(`worker.load root='${root}' count=${list.length}`); } catch {}
}

export async function setActiveFileIndexRoot(winRoot: string, excludes?: string[]): Promise<void> {
  touchAtUsage();
  const prevRoot = currentRoot;
  lastActiveRoot = winRoot;
  currentRoot = winRoot;
  const switched = !isSameRoot(prevRoot, winRoot);
  if (switched) {
    // 切换项目时主动收敛缓存与 Worker，避免旧大仓库数据常驻
    trimRendererCaches(winRoot);
    if (!isSameRoot(workerRoot, winRoot)) disposeWorker();
  }
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
            const rootKey = currentRoot ?? root;
            const key = normalizeRootKey(rootKey);
            const hasPatch = (Array.isArray(adds) && adds.length > 0) || (Array.isArray(removes) && removes.length > 0);
            if (hasPatch) {
              let list = cacheByRoot.get(key) || [];
              let idx = cacheIndexByRoot.get(key) || new Map<string, FileCandidate>();
              if (idx.size === 0 && list.length > 0) idx = buildIndexFor(list);
              const addsList = Array.isArray(adds) ? adds : [];
              const removesList = Array.isArray(removes) ? removes : [];
              let changed = false;
              // 应用新增
              for (const a of addsList) {
                const k = `${a.isDir ? KEY_PREFIX_DIR : KEY_PREFIX_FILE}:${a.rel}`;
                if (!idx.has(k)) { const it = { rel: a.rel, isDir: !!a.isDir } as FileCandidate; idx.set(k, it); list.push(it); changed = true; }
              }
              // 应用删除（批量过滤更快）
              if (removesList.length > 0 && list.length > 0) {
                const rm = new Set(removesList.map(r => `${r.isDir ? KEY_PREFIX_DIR : KEY_PREFIX_FILE}:${r.rel}`));
                if (rm.size > 0) {
                  const kept: FileCandidate[] = [];
                  let removedAny = false;
                  for (const it of list) {
                    const mk = `${it.isDir ? KEY_PREFIX_DIR : KEY_PREFIX_FILE}:${it.rel}`;
                    if (rm.has(mk)) { removedAny = true; continue; }
                    kept.push(it);
                  }
                  if (removedAny) {
                    list = kept;
                    idx = buildIndexFor(kept);
                    changed = true;
                  }
                }
              }
              idx = storeCacheEntry(rootKey, list, idx);
              if (changed) {
                ensureWorker();
                try { worker?.postMessage({ type: 'patch', adds: addsList, removes: removesList }); } catch {}
                try { await (window as any).host?.utils?.perfLog?.(`[atSearch] patched root='${currentRoot}' adds=${addsList.length} removes=${removesList.length} total=${(cacheByRoot.get(key) || []).length}`); } catch {}
              }
            } else {
              // 兼容兜底：全量刷新（避免极端情况下 patch 丢失）
              try { await (window as any).host?.utils?.perfLog?.(`[atSearch] onChanged(root-only) root='${root}' current='${currentRoot}'`); } catch {}
              const list = await getAllCandidates(currentRoot).catch(() => [] as FileCandidate[]);
              const idx = buildIndexFor(list);
              storeCacheEntry(rootKey, list, idx);
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
  touchAtUsage();
  await restoreActiveRootIfCleared("search");

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
    // 根据候选规模动态等待更长时间，避免大仓库过早超时导致 0 结果
    const rootKey = String(currentRoot || '').toLowerCase();
    const localAll = cacheByRoot.get(rootKey) || [];
    const waitMs = localAll.length > 100000 ? 350 : localAll.length > 30000 ? 200 : 60;
    // 统一 Promise，确保无论超时还是收到结果，都移除监听，避免泄漏
    let ranked = await new Promise<any[]>((resolve) => {
      let timeoutId: number | undefined;
      const handler = (ev: MessageEvent) => {
        const data: any = ev.data || {};
        if (data && data.type === 'result' && String(data.q) === q) {
          try { if (typeof timeoutId === 'number') window.clearTimeout(timeoutId); } catch {}
          try { w.removeEventListener('message', handler as any); } catch {}
          resolve(Array.isArray(data.items) ? data.items : []);
        }
      };
      try { w.addEventListener('message', handler as any, { once: false }); } catch {}
      try {
        w.postMessage({ type: 'query', q, limit: want });
      } catch {
        try { w.removeEventListener('message', handler as any); } catch {}
        resolve([]);
        return;
      }
      timeoutId = window.setTimeout(() => {
        try { w.removeEventListener('message', handler as any); } catch {}
        resolve([]);
      }, waitMs);
    });

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
