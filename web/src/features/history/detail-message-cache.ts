import type { HistoryMessage, HistorySession } from "@/app/app-shared";

export type HistoryDetailLoadReuseOptions = {
  lastLoadedFingerprint: string;
  requestedFingerprint: string;
  lastLoadedMessageCount: number | null;
  cachedMessageCount: number;
};

/**
 * 根据会话字段及可选刷新版本生成详情读取指纹，避免仅对象身份变化时重复读取。
 */
export function buildHistoryDetailSessionFingerprint(session: HistorySession | null, refreshNonce = 0): string {
  if (!session) return "none";
  const parts = [
    session.providerId,
    session.id,
    session.filePath || "",
    session.date || "",
    session.resumeMode || "",
    session.resumeId || "",
    session.preview || "",
    session.rawDate || "",
    session.runtimeShell || "",
  ];
  const revision = Number.isFinite(refreshNonce) ? Math.max(0, Math.trunc(refreshNonce)) : 0;
  if (revision > 0) parts.push(String(revision));
  return parts.join("|");
}

/**
 * 判断历史详情是否仍可复用上次读取结果；曾读到正文但缓存已被裁剪时必须重新读取。
 */
export function shouldReuseHistoryDetailLoad(options: HistoryDetailLoadReuseOptions): boolean {
  if (options.lastLoadedFingerprint !== options.requestedFingerprint) return false;
  if (Math.max(0, options.cachedMessageCount) > 0) return true;
  return options.lastLoadedMessageCount === 0;
}

/**
 * 将读取完成的正文写入本地会话列表；快速切换导致目标暂时缺席时补入该会话。
 */
export function upsertHistoryDetailSessionMessages(
  sessions: HistorySession[],
  selectedSession: HistorySession,
  messages: HistoryMessage[],
): HistorySession[] {
  const targetId = String(selectedSession.id || "");
  const targetIndex = sessions.findIndex((session) => session.id === targetId);
  const loadedSession: HistorySession = { ...selectedSession, messages };
  if (targetIndex < 0) return [...sessions, loadedSession];
  return sessions.map((session, index) => (
    index === targetIndex ? { ...session, ...loadedSession } : session
  ));
}
