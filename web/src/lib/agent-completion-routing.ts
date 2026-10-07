import { findBestMatchingProjectScopeKey, normalizePathScopeKey } from "./path-scope";

export type AgentCompletionRoutePayload = {
  tabId?: string;
  providerId?: string;
  envLabel?: string;
  threadId?: string;
  cwd?: string;
  timestamp?: string;
  completionKind?: string;
  hookEventName?: string;
};

type CompletionRouteTab = {
  id: string;
  name: string;
  providerId: string;
  historySessionId?: string;
};

type CompletionRouteContext = {
  tabsByProject: Record<string, CompletionRouteTab[]>;
  projects: readonly { id: string; winPath: string; wslPath: string }[];
  sessionIdByTab: Record<string, string>;
  timersByTab: Record<string, { status: string; startedAt: number }>;
};

/** 按会话和项目核对 Codex 通知归属，兼容共享服务继承了其它标签环境变量的情况。 */
export function resolveAgentCompletionTab(
  payload: AgentCompletionRoutePayload,
  context: CompletionRouteContext,
): string | null {
  const direct = String(payload.tabId || "").trim();
  const providerId = String(payload.providerId || "codex").trim().toLowerCase();
  const envLabel = String(payload.envLabel || "").trim();
  const tabs = Object.entries(context.tabsByProject).flatMap(([projectId, list]) =>
    (list || []).filter((tab) => String(tab.providerId || "").trim().toLowerCase() === providerId).map((tab) => ({ tab, projectId })),
  );
  const directTab = tabs.find(({ tab }) => tab.id === direct);
  if (providerId !== "codex") {
    if (direct) return directTab?.tab.id || null;
    const matches = tabs.filter(({ tab }) => !envLabel || String(tab.name || "").trim() === envLabel);
    return matches.length === 1 ? matches[0].tab.id : null;
  }
  // 未标记来源的外部终端不能凭项目路径结束应用内任务。
  if (!direct) return null;
  const threadId = String(payload.threadId || "").trim().toLowerCase();
  const cwd = normalizePathScopeKey(payload.cwd || "");
  const scopes = context.projects.flatMap((project) => [project.winPath, project.wslPath]).filter(Boolean);
  const bestScope = cwd ? findBestMatchingProjectScopeKey(cwd, scopes) : "";
  const projectIds = new Set(context.projects.filter((project) =>
    bestScope && [project.winPath, project.wslPath].some((scope) => normalizePathScopeKey(scope) === bestScope),
  ).map((project) => project.id));
  const isSubagent = String(payload.completionKind || "").trim().toLowerCase() === "subagent" || payload.hookEventName === "SubagentStop";
  const eventAt = Date.parse(payload.timestamp || "");
  const candidates = tabs.filter(({ tab, projectId }) => {
    if (cwd && !projectIds.has(projectId)) return false;
    const timer = context.timersByTab[tab.id];
    return !(timer?.status === "working" && Number.isFinite(eventAt) && eventAt < timer.startedAt - 2_000);
  });
  /** 优先读取当前运行中的绑定，避免持久化的旧编号覆盖新会话。 */
  const boundSession = ({ tab }: typeof tabs[number]): string =>
    String(context.sessionIdByTab[tab.id] || tab.historySessionId || "").trim().toLowerCase();
  const sessionMatches = isSubagent || !threadId ? [] : candidates.filter((candidate) => boundSession(candidate) === threadId);
  if (sessionMatches.length === 1) return sessionMatches[0].tab.id;
  if (sessionMatches.length > 1) return sessionMatches.find(({ tab }) => tab.id === direct)?.tab.id || null;
  const validDirect = candidates.find(({ tab }) => tab.id === direct);
  if (validDirect && (isSubagent || !threadId || !boundSession(validDirect) || boundSession(validDirect) === threadId))
    return validDirect.tab.id;
  // 缺少已绑定编号时，只恢复同项目唯一正在运行且尚未绑定的标签。
  if (!threadId || !cwd) return null;
  const activeUnbound = candidates.filter((candidate) =>
    context.timersByTab[candidate.tab.id]?.status === "working" && !boundSession(candidate),
  );
  return activeUnbound.length === 1 ? activeUnbound[0].tab.id : null;
}
