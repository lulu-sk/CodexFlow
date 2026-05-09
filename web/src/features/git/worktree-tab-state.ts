import type { GitWorktreeItem } from "./types";

export type WorktreeTabPreferences = {
  openedByUser: boolean;
  closedByUser: boolean;
  featureUsed: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const WORKTREE_TAB_STORAGE_KEY = "cf.gitWorkbench.worktrees.tab.v1";

/**
 * 返回 Worktrees 页签的默认偏好，供首屏与损坏缓存回退时统一复用。
 */
export function createDefaultWorktreeTabPreferences(): WorktreeTabPreferences {
  return {
    openedByUser: false,
    closedByUser: false,
    featureUsed: false,
  };
}

/**
 * 从本地缓存读取 Worktrees 页签偏好；读取失败时回退到默认值，避免阻断主流程。
 */
export function loadWorktreeTabPreferences(storage?: StorageLike | null): WorktreeTabPreferences {
  const fallback = createDefaultWorktreeTabPreferences();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(WORKTREE_TAB_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw || "{}") as Partial<WorktreeTabPreferences>;
    return {
      openedByUser: parsed.openedByUser === true,
      closedByUser: parsed.closedByUser === true,
      featureUsed: parsed.featureUsed === true,
    };
  } catch {
    return fallback;
  }
}

/**
 * 持久化 Worktrees 页签偏好；失败时静默忽略，保持 UI 可继续使用。
 */
export function saveWorktreeTabPreferences(
  storage: StorageLike | null | undefined,
  preferences: WorktreeTabPreferences,
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKTREE_TAB_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // 忽略缓存写入失败
  }
}

/**
 * 统计当前仓库是否存在可展示的额外 worktree；主 worktree 单独存在时视为“空态”。
 */
export function hasAdditionalWorktrees(items: GitWorktreeItem[] | null | undefined): boolean {
  return Array.isArray(items) && items.length > 1;
}

/**
 * 当前产品设计要求 Git 面板底部页签区中的 Worktrees 页签常驻，避免主入口被隐藏；
 * 因此这里始终返回显示态。设计如此，此处在“底部页签显隐策略”范围内继续不对齐 IDEA。
 */
export function shouldShowWorktreeTab(args: {
  preferences: WorktreeTabPreferences;
  items: GitWorktreeItem[] | null | undefined;
}): boolean {
  void args;
  return true;
}

/**
 * 当前产品设计下，Git 面板底部页签区中的 Worktrees 页签既然已经常驻，就不再额外显示 NEW badge；
 * 因此这里始终关闭 badge。设计如此，此处在“底部页签 badge 策略”范围内继续不对齐 IDEA。
 */
export function shouldShowWorktreeNewBadge(args: {
  preferences: WorktreeTabPreferences;
  items: GitWorktreeItem[] | null | undefined;
}): boolean {
  void args;
  return false;
}

/**
 * 标记用户显式打开过 Worktrees 页签；会清除“已关闭”状态并消耗 NEW badge。
 */
export function markWorktreeTabOpenedByUser(
  preferences: WorktreeTabPreferences,
): WorktreeTabPreferences {
  return {
    openedByUser: true,
    closedByUser: false,
    featureUsed: true,
  };
}

/**
 * 标记用户显式关闭过 Worktrees 页签；后续仅在再次手动打开时恢复显示。
 */
export function markWorktreeTabClosedByUser(
  preferences: WorktreeTabPreferences,
): WorktreeTabPreferences {
  return {
    ...preferences,
    closedByUser: true,
    openedByUser: false,
  };
}

/**
 * 标记用户已经实际使用过 worktree 功能，后续不再展示 NEW badge。
 */
export function markWorktreeFeatureUsed(
  preferences: WorktreeTabPreferences,
): WorktreeTabPreferences {
  return {
    ...preferences,
    featureUsed: true,
  };
}
