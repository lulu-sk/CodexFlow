/**
 * 在异步读取尚未写回筛选状态时使用当前会话的默认筛选器，避免空对象过滤全部正文。
 */
export function resolveHistoryDetailTypeFilter(
  current: Record<string, boolean>,
  fallback: Record<string, boolean>,
): Record<string, boolean> {
  return Object.keys(current).length > 0 ? current : fallback;
}

/** 默认展示主对话与改动，压缩摘要等辅助类型需用户手动勾选。 */
export function isHistoryDetailTypeVisibleByDefault(key: string): boolean {
  return key === "input_text"
    || key === "output_text"
    || key === "image"
    || key === "subagent_notification"
    || key === "turn_diff";
}
