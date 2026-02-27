// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * “删除 worktree / 对齐到主 worktree”对话框偏好持久化。
 *
 * 设计目标：
 * - 按仓库维度（repoKey）隔离，避免不同仓库互相覆盖；
 * - 仅保存一个稳定偏好：是否默认勾选“保留目录并对齐到主 worktree”；
 * - 读写失败时静默降级，不阻断主流程。
 */

const WORKTREE_DELETE_PREFS_STORAGE_KEY = "codexflow.worktreeDeletePrefs.v1";
const WORKTREE_DELETE_PREFS_VERSION = 1 as const;

export type WorktreeDeletePrefs = {
  preferResetToMain: boolean;
};

type PersistedWorktreeDeletePrefsRoot = {
  version: typeof WORKTREE_DELETE_PREFS_VERSION;
  savedAt: number;
  byRepoKey: Record<string, WorktreeDeletePrefs>;
};

/**
 * 中文说明：安全读取 localStorage（某些环境可能抛异常）。
 */
function getLocalStorageSafe(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 中文说明：将输入收敛为可用的 repoKey（去空格）。
 */
function normalizeRepoKey(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return s;
}

/**
 * 中文说明：归一化删除/对齐偏好对象。
 */
function normalizePrefs(input: unknown): WorktreeDeletePrefs {
  const obj = (input && typeof input === "object") ? (input as any) : {};
  return { preferResetToMain: obj.preferResetToMain === true };
}

/**
 * 中文说明：读取指定 repoKey 的删除/对齐偏好；不存在时返回 null。
 */
export function loadWorktreeDeletePrefs(repoKey: string): WorktreeDeletePrefs | null {
  const key = normalizeRepoKey(repoKey);
  if (!key) return null;
  const ls = getLocalStorageSafe();
  if (!ls) return null;
  try {
    const raw = ls.getItem(WORKTREE_DELETE_PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as any;
    if (Number(parsed?.version) !== WORKTREE_DELETE_PREFS_VERSION) return null;
    const byRepoKey = (parsed?.byRepoKey && typeof parsed.byRepoKey === "object") ? parsed.byRepoKey : {};
    const prefsRaw = byRepoKey[key];
    if (!prefsRaw) return null;
    return normalizePrefs(prefsRaw);
  } catch {
    return null;
  }
}

/**
 * 中文说明：写入指定 repoKey 的删除/对齐偏好（覆盖保存）。
 */
export function saveWorktreeDeletePrefs(repoKey: string, prefs: WorktreeDeletePrefs): void {
  const key = normalizeRepoKey(repoKey);
  if (!key) return;
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    let root: PersistedWorktreeDeletePrefsRoot = {
      version: WORKTREE_DELETE_PREFS_VERSION,
      savedAt: Date.now(),
      byRepoKey: {},
    };
    try {
      const raw = ls.getItem(WORKTREE_DELETE_PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as any;
        if (Number(parsed?.version) === WORKTREE_DELETE_PREFS_VERSION && parsed?.byRepoKey && typeof parsed.byRepoKey === "object") {
          root = {
            version: WORKTREE_DELETE_PREFS_VERSION,
            savedAt: Date.now(),
            byRepoKey: parsed.byRepoKey as any,
          };
        }
      }
    } catch {
      // ignore
    }
    root.byRepoKey = { ...(root.byRepoKey || {}), [key]: normalizePrefs(prefs) };
    root.savedAt = Date.now();
    ls.setItem(WORKTREE_DELETE_PREFS_STORAGE_KEY, JSON.stringify(root));
  } catch {
    // ignore
  }
}
