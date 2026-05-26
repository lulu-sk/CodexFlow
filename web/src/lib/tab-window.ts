// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 主窗口的稳定标识，未显式分配宿主窗口的标签页默认归属于该窗口。
 */
export const MAIN_APP_WINDOW_ID = "main";

/**
 * 应用窗口模式；主窗口承载完整工作区，独立标签窗口仅承载被分离的标签页。
 */
export type AppWindowMode = "main" | "detached-tab";

/**
 * 独立标签功能所需的最小标签结构。
 */
export type WindowScopedTabLike = {
  id: string;
  windowId?: string;
};

/**
 * 渲染进程当前窗口的上下文信息。
 */
export type AppWindowContext = {
  windowId: string;
  mode: AppWindowMode;
  isDetachedTabWindow: boolean;
};

/**
 * 从当前 URL 查询串解析窗口上下文；异常场景下一律回退为主窗口。
 */
export function parseAppWindowContext(): AppWindowContext {
  try {
    const search = typeof window !== "undefined" ? String(window.location?.search || "") : "";
    const params = new URLSearchParams(search);
    const rawWindowId = String(params.get("windowId") || "").trim();
    const rawMode = String(params.get("windowMode") || "").trim().toLowerCase();
    const mode: AppWindowMode = rawMode === "detached-tab" ? "detached-tab" : "main";
    const windowId = rawWindowId || MAIN_APP_WINDOW_ID;
    return {
      windowId,
      mode,
      isDetachedTabWindow: mode === "detached-tab" && windowId !== MAIN_APP_WINDOW_ID,
    };
  } catch {
    return {
      windowId: MAIN_APP_WINDOW_ID,
      mode: "main",
      isDetachedTabWindow: false,
    };
  }
}

/**
 * 读取标签页当前宿主窗口；空值与非法值统一归并到主窗口。
 */
export function resolveTabWindowId(tab: WindowScopedTabLike | null | undefined): string {
  const id = String(tab?.windowId || "").trim();
  return id || MAIN_APP_WINDOW_ID;
}

/**
 * 判断标签页是否属于指定窗口。
 */
export function isTabOwnedByWindow(tab: WindowScopedTabLike | null | undefined, windowId: string): boolean {
  return resolveTabWindowId(tab) === String(windowId || "").trim();
}

/**
 * 在共享标签数组中，仅重排当前窗口可见标签的相对顺序，其他窗口标签保持原位不动。
 */
export function reorderTabsWithinWindow<T extends WindowScopedTabLike>(
  tabs: T[],
  windowId: string,
  draggedTabId: string,
  targetTabId: string,
): T[] {
  const ownerId = String(windowId || "").trim() || MAIN_APP_WINDOW_ID;
  const dragId = String(draggedTabId || "").trim();
  const dropId = String(targetTabId || "").trim();
  if (!dragId || !dropId || dragId === dropId || tabs.length <= 1) return tabs;

  const ownedIndexes: number[] = [];
  const ownedTabs: T[] = [];
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (!isTabOwnedByWindow(tab, ownerId)) continue;
    ownedIndexes.push(index);
    ownedTabs.push(tab);
  }
  if (ownedTabs.length <= 1) return tabs;

  const fromIndex = ownedTabs.findIndex((tab) => String(tab.id || "").trim() === dragId);
  const toIndex = ownedTabs.findIndex((tab) => String(tab.id || "").trim() === dropId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return tabs;

  const nextOwnedTabs = ownedTabs.slice();
  const [moved] = nextOwnedTabs.splice(fromIndex, 1);
  if (!moved) return tabs;
  nextOwnedTabs.splice(toIndex, 0, moved);

  const nextTabs = tabs.slice();
  ownedIndexes.forEach((tabIndex, orderIndex) => {
    nextTabs[tabIndex] = nextOwnedTabs[orderIndex];
  });
  return nextTabs;
}

/**
 * 按插入索引重排当前窗口可见标签顺序，适用于自定义指针拖拽排序。
 */
export function reorderTabsWithinWindowByInsertIndex<T extends WindowScopedTabLike>(
  tabs: T[],
  windowId: string,
  draggedTabId: string,
  insertIndex: number,
): T[] {
  const ownerId = String(windowId || "").trim() || MAIN_APP_WINDOW_ID;
  const dragId = String(draggedTabId || "").trim();
  const normalizedInsertIndex = Number.isFinite(insertIndex) ? Math.max(0, Math.trunc(insertIndex)) : 0;
  if (!dragId || tabs.length <= 1)
    return tabs;

  const ownedIndexes: number[] = [];
  const ownedTabs: T[] = [];
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (!isTabOwnedByWindow(tab, ownerId))
      continue;
    ownedIndexes.push(index);
    ownedTabs.push(tab);
  }
  if (ownedTabs.length <= 1)
    return tabs;

  const fromIndex = ownedTabs.findIndex((tab) => String(tab.id || "").trim() === dragId);
  if (fromIndex < 0)
    return tabs;

  const nextOwnedTabs = ownedTabs.slice();
  const [moved] = nextOwnedTabs.splice(fromIndex, 1);
  if (!moved)
    return tabs;

  const boundedInsertIndex = Math.min(normalizedInsertIndex, nextOwnedTabs.length);
  nextOwnedTabs.splice(boundedInsertIndex, 0, moved);

  const unchanged = ownedTabs.every((tab, index) => nextOwnedTabs[index]?.id === tab.id);
  if (unchanged)
    return tabs;

  const nextTabs = tabs.slice();
  ownedIndexes.forEach((tabIndex, orderIndex) => {
    nextTabs[tabIndex] = nextOwnedTabs[orderIndex];
  });
  return nextTabs;
}

/**
 * 从共享 tabsByProject 中反查指定窗口当前承载的首个项目。
 */
export function findFirstProjectIdForWindowTabs<T extends WindowScopedTabLike>(
  tabsByProject: Record<string, T[]>,
  windowId: string,
): string {
  const ownerId = String(windowId || "").trim() || MAIN_APP_WINDOW_ID;
  for (const [projectId, tabs] of Object.entries(tabsByProject || {})) {
    if (!Array.isArray(tabs) || tabs.length <= 0) continue;
    if (tabs.some((tab) => isTabOwnedByWindow(tab, ownerId))) return projectId;
  }
  return "";
}

/**
 * 将单个标签页迁移到目标窗口，并返回命中的项目标识。
 */
export function moveTabBetweenWindows<T extends WindowScopedTabLike>(
  tabsByProject: Record<string, T[]>,
  tabId: string,
  targetWindowId: string,
): { nextTabsByProject: Record<string, T[]>; movedProjectId: string; changed: boolean } {
  const safeTabId = String(tabId || "").trim();
  const safeWindowId = String(targetWindowId || "").trim() || MAIN_APP_WINDOW_ID;
  if (!safeTabId) {
    return { nextTabsByProject: tabsByProject, movedProjectId: "", changed: false };
  }

  let movedProjectId = "";
  let changed = false;
  const nextTabsByProject: Record<string, T[]> = { ...tabsByProject };
  for (const [projectId, tabs] of Object.entries(tabsByProject || {})) {
    if (!Array.isArray(tabs) || tabs.length <= 0) continue;
    let projectChanged = false;
    const nextTabs = tabs.map((tab) => {
      if (String(tab.id || "").trim() !== safeTabId) return tab;
      if (resolveTabWindowId(tab) === safeWindowId) return tab;
      movedProjectId = projectId;
      projectChanged = true;
      changed = true;
      return { ...tab, windowId: safeWindowId };
    });
    if (projectChanged) nextTabsByProject[projectId] = nextTabs;
  }

  return { nextTabsByProject, movedProjectId, changed };
}

/**
 * 将指定窗口承载的全部标签页迁移到另一个窗口；未命中的项目数组保持引用不变。
 */
export function moveWindowOwnedTabs<T extends WindowScopedTabLike>(
  tabsByProject: Record<string, T[]>,
  sourceWindowId: string,
  targetWindowId: string,
): { nextTabsByProject: Record<string, T[]>; changed: boolean } {
  const fromWindowId = String(sourceWindowId || "").trim() || MAIN_APP_WINDOW_ID;
  const toWindowId = String(targetWindowId || "").trim() || MAIN_APP_WINDOW_ID;
  if (fromWindowId === toWindowId) {
    return { nextTabsByProject: tabsByProject, changed: false };
  }

  let changed = false;
  const nextTabsByProject: Record<string, T[]> = { ...tabsByProject };
  for (const [projectId, tabs] of Object.entries(tabsByProject || {})) {
    if (!Array.isArray(tabs) || tabs.length <= 0) continue;
    let projectChanged = false;
    const nextTabs = tabs.map((tab) => {
      if (!isTabOwnedByWindow(tab, fromWindowId)) return tab;
      projectChanged = true;
      changed = true;
      return { ...tab, windowId: toWindowId };
    });
    if (projectChanged) nextTabsByProject[projectId] = nextTabs;
  }
  return { nextTabsByProject, changed };
}

/**
 * 统计指定窗口当前承载的标签页数量。
 */
export function countWindowOwnedTabs<T extends WindowScopedTabLike>(
  tabsByProject: Record<string, T[]>,
  windowId: string,
): number {
  const ownerId = String(windowId || "").trim() || MAIN_APP_WINDOW_ID;
  let count = 0;
  for (const tabs of Object.values(tabsByProject || {})) {
    if (!Array.isArray(tabs) || tabs.length <= 0) continue;
    for (const tab of tabs) {
      if (isTabOwnedByWindow(tab, ownerId)) count += 1;
    }
  }
  return count;
}
