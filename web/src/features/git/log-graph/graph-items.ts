import type { GitLogItem } from "../types";

/**
 * 合并分页返回的图谱上下文提交序列。
 * 普通 `items` 按页不重叠，但 `graphItems` 为了给图谱补尾部上下文会和上一页重叠；
 * 这里按提交哈希去重并保留首次出现顺序，避免分页加载后把同一段 permanent graph 追加两次。
 */
export function mergePagedGitLogGraphItems(
  previousItems: GitLogItem[],
  nextItems: GitLogItem[],
): GitLogItem[] {
  const merged: GitLogItem[] = [];
  const seenHashes = new Set<string>();
  appendUniqueGitLogGraphItems(merged, seenHashes, previousItems);
  appendUniqueGitLogGraphItems(merged, seenHashes, nextItems);
  return merged;
}

/**
 * 把输入序列里尚未出现过的提交按原顺序追加到结果中。
 */
function appendUniqueGitLogGraphItems(
  target: GitLogItem[],
  seenHashes: Set<string>,
  items: GitLogItem[],
): void {
  for (const item of items) {
    const hash = String(item?.hash || "").trim();
    if (!hash || seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    target.push(item);
  }
}
