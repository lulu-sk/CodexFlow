// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { requestHistoryFastRefresh, type HistoryRefreshRequest } from "./historyReconciler";

const HISTORY_LIST_PROVIDER_IDS = new Set<HistoryListRecoveryProviderId>([
  "codex",
  "claude",
  "gemini",
  "antigravity",
  "grok",
]);

export type HistoryListRecoveryProviderId = "codex" | "claude" | "gemini" | "antigravity" | "grok";

export type HistoryListRecoveryHint = {
  providerId?: string;
  threadId?: string;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
};

export type IndexedHistoryRecoveryItem = {
  providerId?: string;
  id?: string;
  resumeId?: string;
};

export type HistoryListRecoveryProject = {
  projectWslPath?: string;
  projectWinPath?: string;
};

/**
 * 规范化 IPC 传入的短文本，避免无效值或异常长字符串进入后台调度键。
 */
function normalizeRecoveryText(value: unknown, maxLength: number): string {
  return String(value || "").trim().slice(0, maxLength);
}

/**
 * 将外部 Provider 提示收敛到历史索引支持的固定集合。
 */
function normalizeRecoveryProviderId(value: unknown): HistoryListRecoveryProviderId | null {
  const providerId = normalizeRecoveryText(value, 32).toLowerCase() as HistoryListRecoveryProviderId;
  return HISTORY_LIST_PROVIDER_IDS.has(providerId) ? providerId : null;
}

/**
 * 判断索引结果是否已经包含目标会话，避免对已命中的记录重复发起校对。
 */
function hasIndexedRecoveryTarget(
  items: ReadonlyArray<IndexedHistoryRecoveryItem>,
  providerId: HistoryListRecoveryProviderId,
  identities: ReadonlySet<string>,
): boolean {
  if (identities.size === 0) return false;
  return items.some((item) => {
    if (normalizeRecoveryProviderId(item.providerId) !== providerId) return false;
    const itemIds = [item.id, item.resumeId]
      .map((value) => normalizeRecoveryText(value, 512).toLowerCase())
      .filter(Boolean);
    return itemIds.some((identity) => identities.has(identity));
  });
}

/**
 * 在索引未包含目标会话时提交后台定向恢复；该方法不执行目录扫描，也不等待恢复完成。
 */
export function requestHistoryListRecovery(
  hint: HistoryListRecoveryHint | undefined,
  indexedItems: ReadonlyArray<IndexedHistoryRecoveryItem>,
  project: HistoryListRecoveryProject,
): boolean {
  const providerId = normalizeRecoveryProviderId(hint?.providerId);
  if (!providerId) return false;

  const threadId = normalizeRecoveryText(hint?.threadId, 512);
  const sessionId = normalizeRecoveryText(hint?.sessionId, 512);
  const identities = new Set(
    [threadId, sessionId].map((identity) => identity.toLowerCase()).filter(Boolean),
  );
  const rawStartedAt = Number(hint?.startedAt);
  const startedAt = Number.isFinite(rawStartedAt) && rawStartedAt > 0 ? rawStartedAt : undefined;
  if (identities.size === 0 && !startedAt) return false;
  if (hasIndexedRecoveryTarget(indexedItems, providerId, identities)) return false;

  const cwd = normalizeRecoveryText(
    hint?.cwd || project.projectWslPath || project.projectWinPath,
    4_096,
  );
  const request: HistoryRefreshRequest = {
    providerId,
    reason: "history-list-index-miss",
  };
  if (threadId) request.threadId = threadId;
  if (sessionId) request.sessionId = sessionId;
  if (cwd) request.cwd = cwd;
  if (startedAt) request.startedAt = startedAt;
  requestHistoryFastRefresh(request);
  return true;
}
