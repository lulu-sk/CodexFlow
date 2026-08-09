// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export const PROJECT_CENTER_VIEW_STATE_STORAGE_KEY = "codexflow.projectCenterViewState.v1";
export const TAB_HISTORY_VIEW_STATE_STORAGE_KEY = "codexflow.tabHistoryViewState.v1";

const GLOBAL_PROJECT_VIEW_KEY = "__global__";
const TAB_HISTORY_VIEW_KEY_PREFIX = "tab:";
const PROJECT_HISTORY_VIEW_KEY_PREFIX = "project:";

export type ProjectCenterMode = "console" | "history";

export type HistoryDetailLayoutMode = "full" | "split";

export type HistoryDetailLayoutState = {
  mode: HistoryDetailLayoutMode;
  canSplit: boolean;
};

export type ProjectCenterViewState = {
  mode: ProjectCenterMode;
};

export type ProjectCenterViewStateMap = Record<string, ProjectCenterViewState>;

export type TabHistoryViewState = {
  selectedHistoryDir: string | null;
  selectedHistoryId: string | null;
  detailScrollProgress: number | null;
};

export type TabHistoryViewStateMap = Record<string, TabHistoryViewState>;

export type HistoryDetailBottomRequest = {
  id: number;
  scrollStateKey: string;
  sessionId: string;
};

/**
 * 根据当前窗口内的终端标签计算历史详情实际布局；只有 Git 标签或没有标签时强制全屏。
 */
export function resolveHistoryDetailLayout(
  preferredMode: HistoryDetailLayoutMode,
  tabs: ReadonlyArray<{ kind?: string | null }>,
): HistoryDetailLayoutState {
  const canSplit = tabs.some((tab) => tab.kind !== "git");
  return {
    mode: canSplit ? preferredMode : "full",
    canSplit,
  };
}

/**
 * 判断一次性底部滚动请求是否属于当前历史详情。
 */
export function shouldApplyHistoryDetailBottomRequest(
  request: HistoryDetailBottomRequest | null,
  scrollStateKey: unknown,
  selectedHistoryId: unknown,
): boolean {
  if (!request) return false;
  const normalizedStateKey = String(scrollStateKey || "").trim();
  const normalizedSessionId = String(selectedHistoryId || "").trim();
  return !!normalizedStateKey
    && !!normalizedSessionId
    && request.scrollStateKey === normalizedStateKey
    && request.sessionId === normalizedSessionId;
}

/**
 * 将项目 ID 规整为可持久化的视图状态键；未选择项目时使用独立的全局键。
 */
export function resolveProjectCenterViewStateKey(projectId: unknown): string {
  return String(projectId || "").trim() || GLOBAL_PROJECT_VIEW_KEY;
}

/**
 * 创建项目中心区域的默认视图状态。
 */
export function createDefaultProjectCenterViewState(): ProjectCenterViewState {
  return { mode: "console" };
}

/**
 * 从本地存储文本中读取有效的项目视图状态，忽略损坏或不兼容的数据。
 */
export function parseProjectCenterViewStateMap(raw: unknown): ProjectCenterViewStateMap {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const states: ProjectCenterViewStateMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Partial<ProjectCenterViewState>;
      states[key] = {
        mode: candidate.mode === "history" ? "history" : "console",
      };
    }
    return states;
  } catch {
    return {};
  }
}

/**
 * 获取指定项目的视图状态；项目尚未记录时返回默认值。
 */
export function getProjectCenterViewState(
  states: ProjectCenterViewStateMap,
  projectId: unknown,
): ProjectCenterViewState {
  return states[resolveProjectCenterViewStateKey(projectId)] || createDefaultProjectCenterViewState();
}

/**
 * 以不可变方式更新指定项目的视图状态，并在内容未变化时复用原对象。
 */
export function updateProjectCenterViewState(
  states: ProjectCenterViewStateMap,
  projectId: unknown,
  patch: Partial<ProjectCenterViewState>,
): ProjectCenterViewStateMap {
  const key = resolveProjectCenterViewStateKey(projectId);
  const current = getProjectCenterViewState(states, projectId);
  const next: ProjectCenterViewState = { ...current, ...patch };
  if (next.mode === current.mode) return states;
  return { ...states, [key]: next };
}

/**
 * 将标签页 ID 规整为历史详情状态键；没有标签页时回退到项目独立键。
 */
export function resolveTabHistoryViewStateKey(tabId: unknown, projectId: unknown): string {
  const normalizedTabId = String(tabId || "").trim();
  if (normalizedTabId) return `${TAB_HISTORY_VIEW_KEY_PREFIX}${normalizedTabId}`;
  return `${PROJECT_HISTORY_VIEW_KEY_PREFIX}${resolveProjectCenterViewStateKey(projectId)}`;
}

/**
 * 创建标签页历史详情的默认状态。
 */
export function createDefaultTabHistoryViewState(): TabHistoryViewState {
  return {
    selectedHistoryDir: null,
    selectedHistoryId: null,
    detailScrollProgress: null,
  };
}

/**
 * 将历史详情滚动百分比限制在 0 到 1 之间；无效值按未记录处理。
 */
export function normalizeHistoryDetailScrollProgress(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return Math.min(1, Math.max(0, numericValue));
}

/**
 * 从本地存储文本中读取有效的标签页历史详情状态。
 */
export function parseTabHistoryViewStateMap(raw: unknown): TabHistoryViewStateMap {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const states: TabHistoryViewStateMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Partial<TabHistoryViewState>;
      states[key] = {
        selectedHistoryDir: typeof candidate.selectedHistoryDir === "string" ? candidate.selectedHistoryDir : null,
        selectedHistoryId: typeof candidate.selectedHistoryId === "string" ? candidate.selectedHistoryId : null,
        detailScrollProgress: normalizeHistoryDetailScrollProgress(candidate.detailScrollProgress),
      };
    }
    return states;
  } catch {
    return {};
  }
}

/**
 * 获取指定标签页的历史详情状态；仅在没有标签页时使用项目兜底状态。
 */
export function getTabHistoryViewState(
  states: TabHistoryViewStateMap,
  tabId: unknown,
  projectId: unknown,
): TabHistoryViewState {
  const tabKey = resolveTabHistoryViewStateKey(tabId, projectId);
  return states[tabKey] || createDefaultTabHistoryViewState();
}

/**
 * 以不可变方式更新指定标签页的历史详情状态，并在内容未变化时复用原对象。
 */
export function updateTabHistoryViewState(
  states: TabHistoryViewStateMap,
  tabId: unknown,
  projectId: unknown,
  patch: Partial<TabHistoryViewState>,
): TabHistoryViewStateMap {
  const key = resolveTabHistoryViewStateKey(tabId, projectId);
  return updateTabHistoryViewStateByKey(states, key, patch);
}

/**
 * 以不可变方式更新已解析的标签页历史状态键，供滚动事件等高频路径复用。
 */
export function updateTabHistoryViewStateByKey(
  states: TabHistoryViewStateMap,
  key: string,
  patch: Partial<TabHistoryViewState>,
): TabHistoryViewStateMap {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return states;
  const current = states[normalizedKey] || createDefaultTabHistoryViewState();
  const next: TabHistoryViewState = { ...current, ...patch };
  if (
    next.selectedHistoryDir === current.selectedHistoryDir
    && next.selectedHistoryId === current.selectedHistoryId
    && next.detailScrollProgress === current.detailScrollProgress
  ) return states;
  return { ...states, [normalizedKey]: next };
}
