type AgentTurnTabLike = {
  id?: string | null;
  providerId?: string | null;
};

type AgentTurnTabsByProject = Record<string, AgentTurnTabLike[]>;

type PruneAgentTurnTimersArgs<TState> = {
  timerByTab: Record<string, TState>;
  tabsByProject: AgentTurnTabsByProject;
  retainedTabIds?: Iterable<string>;
  shouldEnableTimerForProvider: (providerId: string) => boolean;
};

type PruneAgentTurnHistoryArgs<TState> = {
  historyByTab: Record<string, TState[]>;
  tabsByProject: AgentTurnTabsByProject;
  retainedTabIds?: Iterable<string>;
};

type CollectRetainedAgentTurnTabIdsArgs = {
  tabsByProject: AgentTurnTabsByProject;
  registeredTabIds?: Iterable<string>;
  hasLiveUnsyncedTab?: (tabId: string) => boolean;
};

/**
 * 中文说明：收集当前已同步到 `tabsByProject` 的标签页集合及其 Provider。
 */
function collectTrackedAgentTurnTabs(tabsByProject: AgentTurnTabsByProject): {
  activeTabIds: Set<string>;
  providerByTabId: Record<string, string>;
} {
  const activeTabIds = new Set<string>();
  const providerByTabId: Record<string, string> = {};
  for (const list of Object.values(tabsByProject || {})) {
    for (const tab of list || []) {
      const tabId = String(tab?.id || "").trim();
      if (!tabId) continue;
      activeTabIds.add(tabId);
      providerByTabId[tabId] = String(tab?.providerId || "").trim();
    }
  }
  return { activeTabIds, providerByTabId };
}

/**
 * 中文说明：规范化“保留中的标签页”集合，用于兜住“已注册但尚未同步进 tabsByProject”的短暂竞态。
 */
function normalizeRetainedAgentTurnTabIds(retainedTabIds?: Iterable<string>): Set<string> {
  const next = new Set<string>();
  if (!retainedTabIds) return next;
  for (const item of retainedTabIds) {
    const tabId = String(item || "").trim();
    if (!tabId) continue;
    next.add(tabId);
  }
  return next;
}

/**
 * 中文说明：从“已注册 tab 集合”中筛选真正需要保留的未同步 tab。
 * - 仅保留当前尚未同步进 `tabsByProject` 的 tab；
 * - 若提供运行时存活判断，则仅保留仍具备运行时绑定的 tab，避免陈旧映射导致状态泄漏。
 */
export function collectRetainedAgentTurnTabIds(args: CollectRetainedAgentTurnTabIdsArgs): string[] {
  const { activeTabIds } = collectTrackedAgentTurnTabs(args.tabsByProject);
  const registeredTabIds = normalizeRetainedAgentTurnTabIds(args.registeredTabIds);
  const retainedTabIds: string[] = [];
  for (const tabId of registeredTabIds) {
    if (activeTabIds.has(tabId)) continue;
    if (args.hasLiveUnsyncedTab && !args.hasLiveUnsyncedTab(tabId)) continue;
    retainedTabIds.push(tabId);
  }
  return retainedTabIds;
}

/**
 * 中文说明：裁剪标签页计时状态，只保留仍有效或“尚未完成同步”的标签页。
 * - 已同步标签：必须仍存在，且 Provider 仍支持计时；
 * - 保留标签：允许暂时不在 `tabsByProject` 中，避免并发创建 worktree 时被误删。
 */
export function pruneAgentTurnTimers<TState>(args: PruneAgentTurnTimersArgs<TState>): {
  nextTimerByTab: Record<string, TState>;
  changed: boolean;
} {
  const { activeTabIds, providerByTabId } = collectTrackedAgentTurnTabs(args.tabsByProject);
  const retainedTabIds = normalizeRetainedAgentTurnTabIds(args.retainedTabIds);
  let changed = false;
  const nextTimerByTab: Record<string, TState> = {};

  for (const [tabId, state] of Object.entries(args.timerByTab || {})) {
    const safeTabId = String(tabId || "").trim();
    if (!safeTabId) {
      changed = true;
      continue;
    }
    const isSynced = activeTabIds.has(safeTabId);
    const isRetainedUnsynced = !isSynced && retainedTabIds.has(safeTabId);
    if (!isSynced && !isRetainedUnsynced) {
      changed = true;
      continue;
    }
    if (isSynced && !args.shouldEnableTimerForProvider(String(providerByTabId[safeTabId] || ""))) {
      changed = true;
      continue;
    }
    nextTimerByTab[safeTabId] = state;
  }

  return { nextTimerByTab, changed };
}

/**
 * 中文说明：裁剪标签页计时历史，只保留仍有效或“尚未完成同步”的标签页。
 * - 历史不额外校验 Provider，保持现有行为：仅在标签彻底失效时移除。
 */
export function pruneAgentTurnHistory<TState>(args: PruneAgentTurnHistoryArgs<TState>): {
  nextHistoryByTab: Record<string, TState[]>;
  changed: boolean;
} {
  const { activeTabIds } = collectTrackedAgentTurnTabs(args.tabsByProject);
  const retainedTabIds = normalizeRetainedAgentTurnTabIds(args.retainedTabIds);
  let changed = false;
  const nextHistoryByTab: Record<string, TState[]> = {};

  for (const [tabId, history] of Object.entries(args.historyByTab || {})) {
    const safeTabId = String(tabId || "").trim();
    if (!safeTabId) {
      changed = true;
      continue;
    }
    const isSynced = activeTabIds.has(safeTabId);
    const isRetainedUnsynced = !isSynced && retainedTabIds.has(safeTabId);
    if (!isSynced && !isRetainedUnsynced) {
      changed = true;
      continue;
    }
    nextHistoryByTab[safeTabId] = history;
  }

  return { nextHistoryByTab, changed };
}
