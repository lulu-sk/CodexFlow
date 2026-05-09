// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type PushAfterCommitHashEntry = {
  repoRoot: string;
  commitHash: string;
};

export type PushAfterCommitContext = {
  repoRoots: string[];
  commitHashes: PushAfterCommitHashEntry[];
  targetHash?: string;
};

type PendingPushAfterCommitRequest = {
  targetRepoRoot: string;
  targetHash?: string;
};

type PushAfterCommitStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const PENDING_PUSH_AFTER_COMMIT_STORAGE_KEY = "cf.git.pendingPushAfterCommit";

/**
 * 解析当前环境可用的本地存储实现，兼容浏览器与测试宿主。
 */
function getPushAfterCommitStorage(): PushAfterCommitStorageLike | null {
  const globalStorage = (globalThis as { localStorage?: PushAfterCommitStorageLike }).localStorage;
  if (globalStorage) return globalStorage;
  const windowStorage = (globalThis as { window?: { localStorage?: PushAfterCommitStorageLike } }).window?.localStorage;
  return windowStorage || null;
}

/**
 * 持久化一次“切仓后继续打开 push 预览”的请求，供 commit-and-push 跨仓续跑复用。
 */
export function persistPendingPushAfterCommitRequest(request: PendingPushAfterCommitRequest): void {
  const storage = getPushAfterCommitStorage();
  if (!storage) return;
  const targetRepoRoot = String(request.targetRepoRoot || "").trim();
  if (!targetRepoRoot) return;
  try {
    storage.setItem(PENDING_PUSH_AFTER_COMMIT_STORAGE_KEY, JSON.stringify({
      targetRepoRoot,
      targetHash: String(request.targetHash || "").trim() || undefined,
    }));
  } catch {}
}

/**
 * 清理待消费的 push-after-commit 请求，避免历史目标在后续切仓时重复触发。
 */
export function clearPendingPushAfterCommitRequest(): void {
  const storage = getPushAfterCommitStorage();
  if (!storage) return;
  try {
    storage.removeItem(PENDING_PUSH_AFTER_COMMIT_STORAGE_KEY);
  } catch {}
}

/**
 * 按当前仓库消费一次待续推请求；仓库不匹配时保持原值，匹配时立即清理。
 */
export function consumePendingPushAfterCommitRequest(currentRepoRoot: string): PendingPushAfterCommitRequest | null {
  const storage = getPushAfterCommitStorage();
  if (!storage) return null;
  const normalizedCurrentRepoRoot = String(currentRepoRoot || "").trim();
  if (!normalizedCurrentRepoRoot) return null;
  try {
    const raw = storage.getItem(PENDING_PUSH_AFTER_COMMIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingPushAfterCommitRequest | null;
    const targetRepoRoot = String(parsed?.targetRepoRoot || "").trim();
    if (!targetRepoRoot || targetRepoRoot !== normalizedCurrentRepoRoot) return null;
    clearPendingPushAfterCommitRequest();
    return {
      targetRepoRoot,
      targetHash: String(parsed?.targetHash || "").trim() || undefined,
    };
  } catch {
    clearPendingPushAfterCommitRequest();
    return null;
  }
}
