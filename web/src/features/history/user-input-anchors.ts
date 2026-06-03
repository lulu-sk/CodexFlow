import type { HistoryMessage } from "@/types/host";

export type HistoryUserInputAnchorMessageView = {
  messageKey: string;
  message: HistoryMessage;
};

/**
 * 提取历史消息里的文本内容，用于识别 Codex 合成输入。
 */
function getHistoryMessageText(message: HistoryMessage): string {
  const items = Array.isArray(message?.content) ? message.content : [];
  return items.map((item) => String(item?.text || "")).filter((text) => text.trim().length > 0).join("\n").trim();
}

/**
 * 判断历史消息是否只包含子代理通知。
 */
function isHistorySubagentNotificationMessage(message: HistoryMessage): boolean {
  const items = Array.isArray(message?.content) ? message.content : [];
  if (items.length === 0) return false;
  return items.every((item) => String(item?.type || "").trim().toLowerCase() === "subagent_notification");
}

/**
 * 判断历史消息是否为 Codex goal 内部上下文。
 */
function isHistoryGoalContextMessage(message: HistoryMessage): boolean {
  return /^<codex_internal_context\b(?=[^>]*\bsource\s*=\s*["']?goal["']?)/i.test(getHistoryMessageText(message).trim());
}

/**
 * 判断历史消息是否为 Codex 中断标记。
 */
function isHistoryTurnAbortedMessage(message: HistoryMessage): boolean {
  return /^<turn_aborted>/i.test(getHistoryMessageText(message).trim());
}

/**
 * 判断某条历史消息是否属于 USER Input 锚点候选。
 */
function isHistoryUserInputMessage(message: HistoryMessage): boolean {
  return String(message?.role || "").trim().toLowerCase() === "user"
    && !isHistorySubagentNotificationMessage(message)
    && !isHistoryTurnAbortedMessage(message);
}

/**
 * 构造 USER Input 锚点序列；首个 goal context 代表线程目标，后续重复 goal context 不再计入跳转。
 */
export function buildHistoryUserInputMessageKeys(messages: HistoryUserInputAnchorMessageView[]): string[] {
  const keys: string[] = [];
  let hasGoalContextInput = false;
  for (const view of messages) {
    if (!isHistoryUserInputMessage(view.message)) continue;
    if (isHistoryGoalContextMessage(view.message)) {
      if (hasGoalContextInput) continue;
      hasGoalContextInput = true;
    }
    keys.push(view.messageKey);
  }
  return keys;
}
