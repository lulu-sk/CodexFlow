// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const DEFAULT_SESSION_START_TOLERANCE_MS = 20 * 60_000;

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
};

/**
 * 规整用于会话绑定的标识，消除大小写和首尾空白差异。
 */
function normalizeSessionBindingId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
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
 * 为当前终端标签选择最可信的历史会话：先精确匹配 ID，再限定同引擎和相近创建时间。
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
    if (exact) return exact;
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
