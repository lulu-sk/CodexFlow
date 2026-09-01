// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const DEFAULT_SESSION_START_TOLERANCE_MS = 20 * 60_000;
const DEFAULT_ACTIVE_SESSION_START_TOLERANCE_MS = 0;

export type HistorySessionBindingCandidate = {
  id: string;
  providerId: string;
  date: string;
  resumeId?: string;
  filePath?: string;
};

export type HistorySessionBindingContext = {
  providerId: string;
  threadId?: string;
  tabCreatedAt: number;
  startToleranceMs?: number;
  activeTurnStartedAt?: number;
  currentSessionId?: string;
  excludedSessionIds?: readonly string[];
  activityStartToleranceMs?: number;
};

export type HistorySessionBindableTab = {
  id: string;
  historySessionId?: string;
};

export type HistorySessionTabBindingResult<T extends HistorySessionBindableTab> = {
  tabsByProject: Record<string, T[]>;
  projectId: string | null;
  changed: boolean;
};

/**
 * 规整用于会话绑定的标识，消除大小写和首尾空白差异。
 */
function normalizeSessionBindingId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * 判断历史尚未命中时是否应继续等待已知绑定或正在落盘的新会话。
 */
export function shouldWaitForHistorySessionBinding(
  boundSessionId: unknown,
  activeTurnStartedAt: unknown,
): boolean {
  if (normalizeSessionBindingId(boundSessionId)) return true;
  const startedAt = Number(activeTurnStartedAt);
  return Number.isFinite(startedAt) && startedAt > 0;
}

/**
 * 收集历史记录中可能代表真实会话 ID 的字段和文件名片段。
 */
function collectHistorySessionBindingIds(session: HistorySessionBindingCandidate): Set<string> {
  const ids = new Set<string>();
  for (const value of [session.id, session.resumeId]) {
    const normalized = normalizeSessionBindingId(value);
    if (normalized) ids.add(normalized);
  }
  const filePath = normalizeSessionBindingId(session.filePath).replace(/\\/g, "/");
  const fileName = filePath.split("/").pop()?.replace(/\.(jsonl|ndjson|json)$/i, "") || "";
  if (fileName) ids.add(fileName);
  const uuid = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (uuid) ids.add(normalizeSessionBindingId(uuid));
  return ids;
}

/**
 * 将可信会话 ID 写入对应标签，同时保持未命中项目和标签的引用不变。
 */
export function bindHistorySessionIdToTabs<T extends HistorySessionBindableTab>(
  tabsByProject: Record<string, T[]>,
  tabId: string,
  sessionId: string,
  projectIdHint?: string,
): HistorySessionTabBindingResult<T> {
  const safeTabId = String(tabId || "").trim();
  const safeSessionId = String(sessionId || "").trim();
  if (!safeTabId || !safeSessionId)
    return { tabsByProject, projectId: null, changed: false };

  const safeProjectIdHint = String(projectIdHint || "").trim();
  const projectIds = Object.keys(tabsByProject);
  const orderedProjectIds = safeProjectIdHint && projectIds.includes(safeProjectIdHint)
    ? [safeProjectIdHint, ...projectIds.filter((projectId) => projectId !== safeProjectIdHint)]
    : projectIds;
  for (const projectId of orderedProjectIds) {
    const tabs = tabsByProject[projectId] || [];
    const tabIndex = tabs.findIndex((tab) => tab.id === safeTabId);
    if (tabIndex < 0) continue;
    const currentTab = tabs[tabIndex];
    if (normalizeSessionBindingId(currentTab.historySessionId) === normalizeSessionBindingId(safeSessionId))
      return { tabsByProject, projectId, changed: false };
    const nextTabs = [...tabs];
    nextTabs[tabIndex] = { ...currentTab, historySessionId: safeSessionId };
    return {
      tabsByProject: { ...tabsByProject, [projectId]: nextTabs },
      projectId,
      changed: true,
    };
  }
  return { tabsByProject, projectId: null, changed: false };
}

/**
 * 为当前终端标签选择最可信的历史会话：精确线程优先，工作中的标签按文件活动时间识别，否则按标签创建时间兜底。
 */
export function findBestHistorySessionForTab<T extends HistorySessionBindingCandidate>(
  sessions: T[],
  context: HistorySessionBindingContext,
): T | null {
  const providerId = normalizeSessionBindingId(context.providerId);
  const providerSessions = sessions.filter((session) => normalizeSessionBindingId(session.providerId) === providerId);
  const threadId = normalizeSessionBindingId(context.threadId);
  if (threadId) {
    const exact = providerSessions.find((session) => collectHistorySessionBindingIds(session).has(threadId));
    return exact || null;
  }

  const activeTurnStartedAt = Number(context.activeTurnStartedAt);
  if (Number.isFinite(activeTurnStartedAt) && activeTurnStartedAt > 0) {
    const currentSessionId = normalizeSessionBindingId(context.currentSessionId);
    const excludedSessionIds = new Set(
      (context.excludedSessionIds || []).map((sessionId) => normalizeSessionBindingId(sessionId)).filter(Boolean),
    );
    const configuredToleranceMs = Number(
      context.activityStartToleranceMs ?? DEFAULT_ACTIVE_SESSION_START_TOLERANCE_MS,
    );
    const activityStartToleranceMs = Number.isFinite(configuredToleranceMs)
      ? Math.max(0, configuredToleranceMs)
      : DEFAULT_ACTIVE_SESSION_START_TOLERANCE_MS;
    const ranked = providerSessions
      .map((session) => ({
        session,
        ids: collectHistorySessionBindingIds(session),
        timestamp: Date.parse(session.date),
      }))
      .filter((entry) => Number.isFinite(entry.timestamp))
      .filter((entry) => entry.timestamp >= activeTurnStartedAt - activityStartToleranceMs)
      .filter((entry) => {
        for (const sessionId of entry.ids) {
          if (excludedSessionIds.has(sessionId)) return false;
        }
        return true;
      })
      .map((entry) => ({ ...entry, isCurrent: !!currentSessionId && entry.ids.has(currentSessionId) }))
      .sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent) || right.timestamp - left.timestamp);
    return ranked[0]?.session || null;
  }

  const tabCreatedAt = Number(context.tabCreatedAt);
  if (!Number.isFinite(tabCreatedAt) || tabCreatedAt <= 0) return null;
  const toleranceMs = Math.max(60_000, Number(context.startToleranceMs || DEFAULT_SESSION_START_TOLERANCE_MS));
  const ranked = providerSessions
    .map((session) => ({ session, timestamp: Date.parse(session.date) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .map((entry) => ({ ...entry, distance: Math.abs(entry.timestamp - tabCreatedAt) }))
    .filter((entry) => entry.distance <= toleranceMs)
    .sort((left, right) => left.distance - right.distance || right.timestamp - left.timestamp);
  return ranked[0]?.session || null;
}
