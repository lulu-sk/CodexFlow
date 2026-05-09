// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const GIT_LOG_COMMIT_EDITING_PREFS_STORAGE_KEY = "codexflow.gitLogCommitEditingPrefs.v1";
const GIT_LOG_COMMIT_EDITING_PREFS_VERSION = 1 as const;

export type GitLogCommitEditingPrefs = {
  showDropCommitConfirmation: boolean;
};

type PersistedGitLogCommitEditingPrefs = {
  version: typeof GIT_LOG_COMMIT_EDITING_PREFS_VERSION;
  savedAt: number;
  prefs: GitLogCommitEditingPrefs;
};

/**
 * 安全读取 localStorage，避免在受限环境下抛错影响 Git 主流程。
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
 * 把偏好对象收敛为稳定结构；缺省场景默认开启删除提交提醒，对齐 IDEA。
 */
function normalizeGitLogCommitEditingPrefs(input: unknown): GitLogCommitEditingPrefs {
  const obj = (input && typeof input === "object") ? (input as Partial<GitLogCommitEditingPrefs>) : {};
  return {
    showDropCommitConfirmation: obj.showDropCommitConfirmation !== false,
  };
}

/**
 * 读取 Git 日志提交编辑偏好；若无缓存则返回默认值。
 */
export function loadGitLogCommitEditingPrefs(): GitLogCommitEditingPrefs {
  const ls = getLocalStorageSafe();
  if (!ls) return normalizeGitLogCommitEditingPrefs(null);
  try {
    const raw = ls.getItem(GIT_LOG_COMMIT_EDITING_PREFS_STORAGE_KEY);
    if (!raw) return normalizeGitLogCommitEditingPrefs(null);
    const parsed = JSON.parse(raw) as Partial<PersistedGitLogCommitEditingPrefs>;
    if (Number(parsed?.version) !== GIT_LOG_COMMIT_EDITING_PREFS_VERSION) return normalizeGitLogCommitEditingPrefs(null);
    return normalizeGitLogCommitEditingPrefs(parsed?.prefs);
  } catch {
    return normalizeGitLogCommitEditingPrefs(null);
  }
}

/**
 * 写入 Git 日志提交编辑偏好；失败时静默降级，不阻断当前用户操作。
 */
export function saveGitLogCommitEditingPrefs(prefs: GitLogCommitEditingPrefs): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    const payload: PersistedGitLogCommitEditingPrefs = {
      version: GIT_LOG_COMMIT_EDITING_PREFS_VERSION,
      savedAt: Date.now(),
      prefs: normalizeGitLogCommitEditingPrefs(prefs),
    };
    ls.setItem(GIT_LOG_COMMIT_EDITING_PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}
