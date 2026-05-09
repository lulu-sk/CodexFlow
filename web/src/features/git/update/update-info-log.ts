import type {
  GitLogFilters,
  GitUpdateNotificationRange,
  GitUpdateSessionNotificationData,
} from "../types";
import { normalizeGitLogFilters } from "../log-filters";

export type UpdateInfoLogState = {
  notification: GitUpdateSessionNotificationData;
  ranges: GitUpdateNotificationRange[];
  selectedRepoRoot: string;
  filters: GitLogFilters;
  autoOpened: boolean;
};

/**
 * 为 Update Info 范围生成稳定 revision 文本，供独立日志视图直接复用。
 */
export function buildUpdateInfoLogRevision(range?: GitUpdateNotificationRange | null): string {
  const start = String(range?.range?.start || "").trim();
  const end = String(range?.range?.end || "").trim();
  if (!start || !end || start === end) return "";
  return `${start}..${end}`;
}

/**
 * 从 Update Info 状态中解析当前选中的范围；若选中仓失效则回退到首个范围。
 */
export function resolveUpdateInfoLogRange(state?: UpdateInfoLogState | null): GitUpdateNotificationRange | null {
  if (!state) return null;
  const selectedRepoRoot = String(state.selectedRepoRoot || "").trim();
  return state.ranges.find((range) => range.repoRoot === selectedRepoRoot) || state.ranges[0] || null;
}

/**
 * 基于通知与目标范围构建独立 Update Info 日志状态，确保不会污染普通日志筛选。
 */
export function buildUpdateInfoLogState(args: {
  notification: GitUpdateSessionNotificationData;
  preferredRepoRoot?: string;
  autoOpened?: boolean;
  currentPathFilter?: string;
}): UpdateInfoLogState | null {
  const notification = args.notification;
  const ranges = Array.isArray(notification.ranges)
    ? notification.ranges.filter((range) => !!String(range.repoRoot || "").trim() && !!buildUpdateInfoLogRevision(range))
    : [];
  if (ranges.length <= 0) return null;
  const preferredRepoRoot = String(args.preferredRepoRoot || "").trim();
  const selectedRange = ranges.find((range) => range.repoRoot === preferredRepoRoot)
    || notification.primaryRange
    || ranges[0];
  const revision = buildUpdateInfoLogRevision(selectedRange);
  if (!revision) return null;
  return {
    notification: {
      ...notification,
      ranges,
      primaryRange: selectedRange,
    },
    ranges,
    selectedRepoRoot: selectedRange.repoRoot,
    filters: normalizeGitLogFilters({
      text: "",
      caseSensitive: false,
      matchMode: "fuzzy",
      branch: "all",
      author: "",
      dateFrom: "",
      dateTo: "",
      path: String(args.currentPathFilter || "").trim(),
      revision,
      followRenames: false,
    }),
    autoOpened: args.autoOpened === true,
  };
}

/**
 * 切换 Update Info 当前范围时仅更新 repoRoot 与 revision，保留独立路径过滤状态。
 */
export function selectUpdateInfoLogRange(
  state: UpdateInfoLogState,
  nextRepoRoot: string,
): UpdateInfoLogState {
  const selectedRepoRoot = String(nextRepoRoot || "").trim();
  const selectedRange = state.ranges.find((range) => range.repoRoot === selectedRepoRoot) || state.ranges[0];
  const revision = buildUpdateInfoLogRevision(selectedRange);
  return {
    ...state,
    selectedRepoRoot: selectedRange?.repoRoot || state.selectedRepoRoot,
    notification: {
      ...state.notification,
      primaryRange: selectedRange || state.notification.primaryRange,
    },
    filters: normalizeGitLogFilters({
      ...state.filters,
      revision: revision || state.filters.revision,
      branch: "all",
      followRenames: false,
    }),
  };
}
