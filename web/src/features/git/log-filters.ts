import type { GitLogFilters } from "./types";

const DEFAULT_MATCH_MODE: GitLogFilters["matchMode"] = "fuzzy";
const FILTER_TRIGGER_VALUE_LIMIT = 14;

/**
 * 按按钮宽度预算压缩单个筛选值，避免长分支名或用户名把工具栏按钮挤成只剩截断文字。
 */
function compactGitLogFilterValue(value: string): string {
  const clean = String(value || "").trim();
  const chars = Array.from(clean);
  if (chars.length <= FILTER_TRIGGER_VALUE_LIMIT) return clean;
  return `${chars.slice(0, 6).join("")}…${chars.slice(-4).join("")}`;
}

/**
 * 对字符串数组执行裁剪、去重与空值清理，供日志筛选多值状态复用。
 */
function normalizeGitLogFilterStringList(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = String(value || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * 从任意输入中提取分支多选值；兼容旧版单值 `branch` 与新版 `branchValues`。
 */
export function getGitLogBranchFilterValues(filters?: Partial<GitLogFilters> | null): string[] {
  const branchValues = Array.isArray(filters?.branchValues)
    ? normalizeGitLogFilterStringList(filters!.branchValues || [])
    : [];
  if (branchValues.length > 0) return branchValues.filter((value) => value !== "all");
  const legacyValue = String(filters?.branch || "").trim();
  if (!legacyValue || legacyValue === "all") return [];
  return [legacyValue];
}

/**
 * 从任意输入中提取作者多选值；兼容旧版单值 `author` 与新版 `authorValues`。
 */
export function getGitLogAuthorFilterValues(filters?: Partial<GitLogFilters> | null): string[] {
  const authorValues = Array.isArray(filters?.authorValues)
    ? normalizeGitLogFilterStringList(filters!.authorValues || [])
    : [];
  if (authorValues.length > 0) return authorValues;
  const legacyValue = String(filters?.author || "").trim();
  if (!legacyValue) return [];
  return [legacyValue];
}

/**
 * 把日志筛选状态规整到稳定结构，保证单值兼容字段与多值字段始终同步。
 */
export function normalizeGitLogFilters(filters?: Partial<GitLogFilters> | null): GitLogFilters {
  const branchValues = getGitLogBranchFilterValues(filters);
  const authorValues = getGitLogAuthorFilterValues(filters);
  return {
    text: String(filters?.text || ""),
    caseSensitive: filters?.caseSensitive === true,
    matchMode: filters?.matchMode === "exact" || filters?.matchMode === "regex" ? filters.matchMode : DEFAULT_MATCH_MODE,
    branch: branchValues.length === 1 ? branchValues[0] : "all",
    branchValues,
    author: authorValues.length === 1 ? authorValues[0] : "",
    authorValues,
    dateFrom: String(filters?.dateFrom || "").trim(),
    dateTo: String(filters?.dateTo || "").trim(),
    path: String(filters?.path || "").trim(),
    revision: String(filters?.revision || "").trim(),
    followRenames: filters?.followRenames === true,
  };
}

/**
 * 把多值筛选状态压缩成工具栏触发按钮文案，避免顶部栏位被完整列表撑爆。
 */
export function formatGitLogFilterTriggerLabel(
  label: string,
  values: string[],
  options?: { emptyLabel?: string; maxInlineValues?: number },
): string {
  const normalizedValues = normalizeGitLogFilterStringList(values);
  if (normalizedValues.length <= 0) return String(options?.emptyLabel || label || "").trim() || label;
  const maxInlineValues = Math.max(1, Math.floor(Number(options?.maxInlineValues) || 1));
  if (normalizedValues.length <= maxInlineValues)
    return `${label}: ${normalizedValues.map((value) => compactGitLogFilterValue(value)).join(" | ")}`;
  const head = normalizedValues.slice(0, maxInlineValues).map((value) => compactGitLogFilterValue(value)).join(" | ");
  return `${label}: ${head} +${normalizedValues.length - maxInlineValues}`;
}
