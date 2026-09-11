// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const DEFAULT_SESSION_START_TOLERANCE_MS = 20 * 60_000;
const DEFAULT_ACTIVE_SESSION_START_TOLERANCE_MS = 2_000;

export type HistorySessionBindingCandidate = {
  id: string;
  providerId: string;
  date: string;
  resumeId?: string;
  filePath?: string;
  codexRelationship?: { kind: string };
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
  const uuid = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
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
 * 为终端选择历史：已知编号优先，缺少编号时只接受同引擎、未被占用且无歧义的时间候选。
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

  const currentSessionId = normalizeSessionBindingId(context.currentSessionId);
  const current = providerSessions.find((session) => collectHistorySessionBindingIds(session).has(currentSessionId));
  const excludedSessionIds = new Set(
    (context.excludedSessionIds || []).map((sessionId) => normalizeSessionBindingId(sessionId)).filter(Boolean),
  );
  // 时间只能用于无歧义的兜底，不能抢占其他终端或把子代理当成主会话。
  const availableSessions = providerSessions.filter((session) => {
    if (session.codexRelationship?.kind === "subagent") return false;
    for (const sessionId of collectHistorySessionBindingIds(session)) {
      if (excludedSessionIds.has(sessionId)) return false;
    }
    return true;
  });

  const activeTurnStartedAt = Number(context.activeTurnStartedAt);
  if (Number.isFinite(activeTurnStartedAt) && activeTurnStartedAt > 0) {
    // 已绑定会话仍在本轮写入时优先保留，避免被其他终端的较新文件抢走。
    if (current && Date.parse(current.date) >= activeTurnStartedAt) return current;
    const configuredToleranceMs = Number(
      context.activityStartToleranceMs ?? DEFAULT_ACTIVE_SESSION_START_TOLERANCE_MS,
    );
    const activityStartToleranceMs = Number.isFinite(configuredToleranceMs)
      ? Math.max(0, configuredToleranceMs)
      : DEFAULT_ACTIVE_SESSION_START_TOLERANCE_MS;
    const candidates = availableSessions
      .map((session) => ({ session, timestamp: Date.parse(session.date) }))
      .filter((entry) => Number.isFinite(entry.timestamp))
      .filter((entry) => entry.timestamp >= activeTurnStartedAt - activityStartToleranceMs);
    const freshCandidates = candidates.filter((entry) => entry.timestamp >= activeTurnStartedAt);
    if (freshCandidates.length === 1) return freshCandidates[0].session;
    // 文件尚未刷新时可先查看已知历史，但调用方需继续发现本轮会话。
    if (current) return current;
    return candidates.length === 1 ? candidates[0].session : null;
  }

  const tabCreatedAt = Number(context.tabCreatedAt);
  if (!Number.isFinite(tabCreatedAt) || tabCreatedAt <= 0) return null;
  const toleranceMs = Math.max(60_000, Number(context.startToleranceMs || DEFAULT_SESSION_START_TOLERANCE_MS));
  const candidates = availableSessions
    .map((session) => ({ session, timestamp: Date.parse(session.date) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .map((entry) => ({ ...entry, distance: Math.abs(entry.timestamp - tabCreatedAt) }))
    .filter((entry) => entry.distance <= toleranceMs);
  return candidates.length === 1 ? candidates[0].session : null;
}
