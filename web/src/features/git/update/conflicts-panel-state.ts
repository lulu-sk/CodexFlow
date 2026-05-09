import type { GitStatusEntry } from "../types";

export type ConflictsPanelPreferences = {
  gateEnabled: boolean;
  dismissedSignature: string;
};

export type ConflictsPanelSnapshot = {
  signature: string;
  unresolvedCount: number;
  resolvedCount: number;
  hasAny: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const CONFLICTS_PANEL_STORAGE_KEY = "cf.gitWorkbench.conflicts.panel.v1";

/**
 * 返回冲突面板默认偏好；gate 默认开启，贴近 IDEA 默认自动显隐的行为。
 */
export function createDefaultConflictsPanelPreferences(): ConflictsPanelPreferences {
  return {
    gateEnabled: true,
    dismissedSignature: "",
  };
}

/**
 * 读取冲突面板偏好；解析失败时回退默认值，避免旧缓存阻断 Git 面板。
 */
export function loadConflictsPanelPreferences(storage?: StorageLike | null): ConflictsPanelPreferences {
  const fallback = createDefaultConflictsPanelPreferences();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(CONFLICTS_PANEL_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw || "{}") as Partial<ConflictsPanelPreferences>;
    return {
      gateEnabled: parsed.gateEnabled !== false,
      dismissedSignature: String(parsed.dismissedSignature || "").trim(),
    };
  } catch {
    return fallback;
  }
}

/**
 * 持久化冲突面板偏好；失败时静默忽略，不影响当前会话继续处理冲突。
 */
export function saveConflictsPanelPreferences(
  storage: StorageLike | null | undefined,
  preferences: ConflictsPanelPreferences,
): void {
  if (!storage) return;
  try {
    storage.setItem(CONFLICTS_PANEL_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // 忽略缓存写入失败
  }
}

/**
 * 把当前状态快照压缩成稳定 signature；repoRoot/路径/冲突态任一变化都会触发自动重新显示。
 */
function buildConflictSignature(entries: GitStatusEntry[]): string {
  return entries
    .map((entry) => {
      const repoRoot = String(entry.repositoryRoot || "").trim().replace(/\\/g, "/");
      const path = String(entry.path || "").trim().replace(/\\/g, "/");
      const state = String(entry.conflictState || "").trim();
      return `${repoRoot}\u0000${path}\u0000${state}`;
    })
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
}

/**
 * 从 status entries 提取冲突面板所需的计数与 signature，供显隐和关闭记忆统一复用。
 */
export function buildConflictsPanelSnapshot(
  entries: GitStatusEntry[] | null | undefined,
): ConflictsPanelSnapshot {
  const conflictEntries = Array.isArray(entries)
    ? entries.filter((entry) => entry.conflictState === "conflict" || entry.conflictState === "resolved")
    : [];
  const unresolvedCount = conflictEntries.filter((entry) => entry.conflictState === "conflict").length;
  const resolvedCount = conflictEntries.filter((entry) => entry.conflictState === "resolved").length;
  return {
    signature: buildConflictSignature(conflictEntries),
    unresolvedCount,
    resolvedCount,
    hasAny: conflictEntries.length > 0,
  };
}

/**
 * 判断冲突面板当前是否应该显示；关闭记忆仅对相同 signature 生效，新的冲突集会重新出现。
 */
export function shouldShowConflictsPanel(args: {
  preferences: ConflictsPanelPreferences;
  snapshot: ConflictsPanelSnapshot;
}): boolean {
  if (args.preferences.gateEnabled !== true) return false;
  if (!args.snapshot.hasAny) return false;
  return args.preferences.dismissedSignature !== args.snapshot.signature;
}

/**
 * 当冲突集发生变化时清理旧的关闭记忆，保证新的 conflict signature 可以再次自动显隐。
 */
export function clearDismissedConflictsPanelSignature(
  preferences: ConflictsPanelPreferences,
  snapshot: ConflictsPanelSnapshot,
): ConflictsPanelPreferences {
  if (!preferences.dismissedSignature) return preferences;
  if (!snapshot.hasAny) {
    return {
      ...preferences,
      dismissedSignature: "",
    };
  }
  if (!snapshot.signature || preferences.dismissedSignature === snapshot.signature) return preferences;
  return {
    ...preferences,
    dismissedSignature: "",
  };
}

/**
 * 显式显示冲突面板；会同时打开 gate 并清除当前关闭记忆，供“重新启用/手动显示”入口复用。
 */
export function revealConflictsPanel(
  preferences: ConflictsPanelPreferences,
): ConflictsPanelPreferences {
  return {
    gateEnabled: true,
    dismissedSignature: "",
  };
}

/**
 * 关闭当前冲突 signature 对应的面板，但不禁用全局 gate；后续出现新的冲突集仍会自动显示。
 */
export function dismissConflictsPanelForSnapshot(
  preferences: ConflictsPanelPreferences,
  snapshot: ConflictsPanelSnapshot,
): ConflictsPanelPreferences {
  return {
    ...preferences,
    dismissedSignature: snapshot.signature,
  };
}

/**
 * 切换冲突面板 gate；关闭 gate 时保持当前 signature 记忆，重新开启时清空关闭态。
 */
export function setConflictsPanelGateEnabled(
  preferences: ConflictsPanelPreferences,
  enabled: boolean,
): ConflictsPanelPreferences {
  if (!enabled) {
    return {
      ...preferences,
      gateEnabled: false,
    };
  }
  return {
    gateEnabled: true,
    dismissedSignature: "",
  };
}
