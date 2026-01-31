// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { AtCategory, AtCategoryId, AtItem, FileItem, RuleItem, SearchResult, SearchScope } from "@/types/at";
import i18n from "@/i18n/setup";
import { searchAt, type AtSearchWireItem } from "@/lib/fileIndexClient";

// 分类常量（保持不变）
export const AT_CATEGORIES: AtCategory[] = [
  { id: "files", name: "Files & Folders", icon: "FolderOpenDot" },
  { id: "rule", name: "Rules", icon: "ScrollText" },
];

// 渲染层仅维护“当前项目根”，实际候选与搜索在主进程完成（避免全量候选跨进程搬运）
let currentRoot: string | null = null;
let currentExcludes: string[] | undefined;
let lastActiveRoot: string | null = null;
let restoreActiveRootPromise: Promise<void> | null = null;

// 空闲与后台释放：与旧实现保持一致（长期运行时减少 watcher/缓存常驻）
const IDLE_DISPOSE_MS = 3 * 60 * 1000;
const HIDDEN_DISPOSE_MS = 90 * 1000;
let idleTimer: number | null = null;
let hiddenCleanupTimer: number | null = null;
let cleanupHookInstalled = false;

/**
 * 中文说明：读取 @ 搜索调试开关（preload 注入只读缓存）。
 */
function dbgEnabled(): boolean {
  try { return !!(globalThis as any).__cf_at_debug__; } catch { return false; }
}

/**
 * 中文说明：输出 @ 搜索调试日志（仅在开启调试时生效）。
 */
function perfLog(msg: string): void {
  if (!dbgEnabled()) return;
  const line = `[atSearch] ${msg}`;
  try { (window as any).host?.utils?.perfLog?.(line); } catch {}
  try { console.debug(line); } catch {}
}

/**
 * 中文说明：安装空闲/后台清理钩子（仅一次）。
 */
function ensureCleanupHook(): void {
  if (typeof window === "undefined") return;
  if (cleanupHookInstalled) return;
  cleanupHookInstalled = true;
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
          touchAtUsage();
          restoreActiveRootIfCleared("visible").catch(() => {});
        }
      } catch {}
    });
  } catch {}
}

/**
 * 中文说明：主动释放渲染层与主进程侧的资源占用（清空 activeRoots）。
 */
function cleanupRendererResources(reason?: string): void {
  const prevRoot = currentRoot;
  if (prevRoot) lastActiveRoot = prevRoot;
  currentRoot = null;
  currentExcludes = undefined;
  restoreActiveRootPromise = null;
  if (typeof window !== "undefined" && idleTimer !== null) {
    try { window.clearTimeout(idleTimer); } catch {}
  }
  idleTimer = null;
  clearHiddenCleanupTimer();
  try {
    const p = (window as any).host?.fileIndex?.setActiveRoots?.([]);
    if (p && typeof (p as any).catch === "function") (p as Promise<unknown>).catch(() => {});
  } catch {}
  perfLog(`cleanup reason='${reason || "idle"}' root='${prevRoot || ""}'`);
}

/**
 * 中文说明：标记一次 @ 使用，刷新空闲回收计时。
 */
function touchAtUsage(): void {
  if (typeof window === "undefined") return;
  try { if (idleTimer !== null) window.clearTimeout(idleTimer); } catch {}
  idleTimer = window.setTimeout(() => cleanupRendererResources("idle"), IDLE_DISPOSE_MS);
  clearHiddenCleanupTimer();
}

/**
 * 中文说明：清理后台回收计时器。
 */
function clearHiddenCleanupTimer(): void {
  if (typeof window === "undefined") return;
  if (hiddenCleanupTimer !== null) {
    try { window.clearTimeout(hiddenCleanupTimer); } catch {}
  }
  hiddenCleanupTimer = null;
}

/**
 * 中文说明：页面进入后台后延迟释放资源（避免短暂切屏频繁重建）。
 */
function scheduleHiddenCleanup(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  clearHiddenCleanupTimer();
  try {
    if (!document.hidden) return;
    hiddenCleanupTimer = window.setTimeout(() => cleanupRendererResources("hidden"), HIDDEN_DISPOSE_MS);
  } catch {}
}

/**
 * 中文说明：在被空闲/后台清理后，尝试恢复最近一次的项目根，避免首次搜索为空。
 */
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
      perfLog(`restore.root reason='${reason || ""}' root='${restoringRoot || ""}'`);
    } catch {}
  })();
  restoreActiveRootPromise = p.finally(() => { restoreActiveRootPromise = null; });
  try { await restoreActiveRootPromise; } catch {}
}

/**
 * 中文说明：将路径统一为 "/" 分隔的相对路径展示形式。
 */
function toPosixRel(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

/**
 * 中文说明：构造文件/目录条目（id 稳定，避免 React 大量重复卸载/挂载）。
 */
function toFileItem(rel: string, isDir: boolean): FileItem {
  const norm = toPosixRel(rel);
  const i = norm.lastIndexOf("/");
  const base = i >= 0 ? norm.slice(i + 1) : norm;
  return {
    id: `files:${norm}`,
    categoryId: "files",
    title: base || norm,
    subtitle: norm,
    path: norm,
    isDir,
    icon: isDir ? "FolderOpenDot" : "FileText",
  };
}

/**
 * 中文说明：构造规则条目（主要用于展示与插入路径）。
 */
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

/**
 * 中文说明：设置当前项目根，并通知主进程收敛 watcher（只保留该 root）。
 * @param winRoot - Windows/UNC 项目根
 * @param excludes - 额外排除（可选）
 */
export async function setActiveFileIndexRoot(winRoot: string, excludes?: string[]): Promise<void> {
  ensureCleanupHook();
  touchAtUsage();
  const root = String(winRoot || "").trim();
  if (!root) return;
  currentRoot = root;
  lastActiveRoot = root;
  currentExcludes = Array.isArray(excludes) ? excludes.filter((x) => typeof x === "string" && x.trim().length > 0) : undefined;
  try { await (window as any).host?.fileIndex?.setActiveRoots?.([root]); } catch {}
}

/**
 * 中文说明：执行 @ 搜索并返回 UI 需要的结果结构。
 *
 * 根因修复点：
 * - 不再把“全量候选文件列表”拉到渲染进程（也不再塞进 WebWorker）；
 * - 仅向主进程请求 topN 结果，避免首次/大仓库下出现内存峰值导致页面刷新。
 */
export async function searchAtItems(query: string, scope: SearchScope, limit = 30): Promise<SearchResult[]> {
  touchAtUsage();
  await restoreActiveRootIfCleared("search");
  if (!currentRoot) return [];

  const res = await searchAt({
    root: currentRoot,
    query: String(query || ""),
    scope,
    limit,
    excludes: currentExcludes,
  }).catch(() => ({ items: [], total: 0, updatedAt: Date.now() }));

  const items = Array.isArray(res.items) ? (res.items as AtSearchWireItem[]) : [];
  const out: SearchResult[] = [];
  for (const it of items) {
    if (!it || !it.rel) continue;
    if (it.categoryId === "files") {
      const item: AtItem = toFileItem(it.rel, !!it.isDir);
      out.push({ item, score: Number(it.score || 0) });
      continue;
    }
    const groupKey = String((it as any).groupKey || "");
    const group = groupKey ? (i18n.t(`at:groups.${groupKey}`) as string) : undefined;
    const item: AtItem = buildRuleItem(it.rel, group);
    out.push({ item, score: Number(it.score || 0) });
  }
  return out.slice(0, Math.max(0, Math.min(50, limit)));
}

/**
 * 中文说明：按 id 获取分类元数据。
 */
export function getCategoryById(id: AtCategoryId): AtCategory | undefined {
  return AT_CATEGORIES.find((c) => c.id === id);
}

