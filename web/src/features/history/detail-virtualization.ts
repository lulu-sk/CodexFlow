export type HistoryDetailSearchMode = "precise" | "message";

type HistoryDetailSearchModeOptions = {
  queryLength: number;
  messageCount: number;
  totalTextSize: number;
  messageThreshold?: number;
  textThreshold?: number;
  preciseSearchMinQueryLength?: number;
};

type HistoryDetailDomHighlightOptions = {
  searchActive: boolean;
  searchMode: HistoryDetailSearchMode;
};

type HistoryDetailVirtualizationOptions = {
  messageCount: number;
  totalTextSize: number;
  searchActive: boolean;
  domHighlightEnabled?: boolean;
  messageThreshold?: number;
  textThreshold?: number;
};

const DEFAULT_MESSAGE_THRESHOLD = 80;
const DEFAULT_TEXT_THRESHOLD = 80_000;
const DEFAULT_PRECISE_SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * 中文说明：解析历史详情搜索模式。
 * 大会话下的单字符搜索会退化为“按消息匹配”，避免逐字符高亮造成主线程卡顿。
 */
export function resolveHistoryDetailSearchMode(options: HistoryDetailSearchModeOptions): HistoryDetailSearchMode {
  const messageThreshold = Math.max(1, Math.floor(Number(options.messageThreshold) || DEFAULT_MESSAGE_THRESHOLD));
  const textThreshold = Math.max(1, Math.floor(Number(options.textThreshold) || DEFAULT_TEXT_THRESHOLD));
  const preciseSearchMinQueryLength = Math.max(1, Math.floor(Number(options.preciseSearchMinQueryLength) || DEFAULT_PRECISE_SEARCH_MIN_QUERY_LENGTH));
  const queryLength = Math.max(0, Math.floor(Number(options.queryLength) || 0));
  if (queryLength === 0) return "precise";
  if (queryLength >= preciseSearchMinQueryLength) return "precise";
  if (options.messageCount >= messageThreshold) return "message";
  if (options.totalTextSize >= textThreshold) return "message";
  return "precise";
}

/**
 * 中文说明：判断当前搜索是否允许执行 DOM 级全量高亮。
 * 仅精确搜索模式启用，以避免大会话短词查询反复拆装海量 mark 节点。
 */
export function shouldEnableHistoryDetailDomHighlights(options: HistoryDetailDomHighlightOptions): boolean {
  return options.searchActive && options.searchMode === "precise";
}

/**
 * 中文说明：判断历史详情是否应启用虚拟列表。
 * 当搜索需要 DOM 级高亮时保留完整 DOM；否则优先启用虚拟列表降低挂载成本。
 */
export function shouldUseVirtualizedHistoryDetail(options: HistoryDetailVirtualizationOptions): boolean {
  const messageThreshold = Math.max(1, Math.floor(Number(options.messageThreshold) || DEFAULT_MESSAGE_THRESHOLD));
  const textThreshold = Math.max(1, Math.floor(Number(options.textThreshold) || DEFAULT_TEXT_THRESHOLD));
  if (options.searchActive && options.domHighlightEnabled) return false;
  if (options.messageCount >= messageThreshold) return true;
  return options.totalTextSize >= textThreshold;
}

