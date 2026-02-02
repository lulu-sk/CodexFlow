// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type HistoryDomMatch = {
  id: string;
  messageKey: string;
};

export type HistoryFindOptions = {
  /** 高亮查找的根节点（通常为历史详情滚动区域内容根容器）。 */
  root: HTMLElement;
  /** 查找关键字（建议已 trim，大小写策略由 caseSensitive 决定）。 */
  query: string;
  /** 每条消息的容器选择器（需在 DOM 中标记 messageKey）。 */
  messageSelector?: string;
  /** 消息内“可搜索内容域”的选择器（用于避免高亮 UI 文案，如 input/output 标签）。 */
  scopeSelector?: string;
  /** matchId 前缀，用于避免与页面其它 data-match-id 冲突。 */
  matchIdPrefix?: string;
  /** 是否区分大小写。默认 false（与现有历史详情搜索一致）。 */
  caseSensitive?: boolean;
};

const HISTORY_FIND_MARK_ATTR = "data-history-find";
const HISTORY_FIND_MARK_ATTR_VALUE = "1";

// 说明：保持与旧版 highlightSearchMatches 的视觉风格尽量一致
const HISTORY_FIND_MARK_CLASS =
  "rounded-apple px-1 py-0.5 transition-all duration-200 bg-yellow-200/80 dark:bg-yellow-500/30 text-[var(--cf-text-primary)] font-apple-medium";
const HISTORY_FIND_MARK_ACTIVE_CLASS =
  "rounded-apple px-1 py-0.5 transition-all duration-200 bg-[var(--cf-accent)] text-white font-apple-semibold ring-2 ring-[var(--cf-accent)]/50 ring-offset-1 shadow-lg";

/**
 * 中文说明：为 querySelector 属性选择器转义值，避免特殊字符导致选择器无效。
 */
function escapeForAttributeSelector(value: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cssAny = CSS as any;
    if (cssAny && typeof cssAny.escape === "function") return cssAny.escape(value);
  } catch {}
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 中文说明：将某个元素的包裹移除，保留其子节点顺序（用于撤销高亮 mark）。
 */
function unwrapElement(el: HTMLElement): void {
  try {
    // 说明：优先使用 replaceWith，避免在 React/DOM 频繁更新时出现 parent-child 关系变更导致的 removeChild 异常
    const children = Array.from(el.childNodes);
    el.replaceWith(...children);
    return;
  } catch {}

  // 兜底：手动搬运子节点并移除自身（需做关系校验，避免抛出 removeChild 异常）
  const parent = el.parentNode;
  if (!parent) return;
  try {
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
  } catch {}
  try {
    if (el.parentNode === parent) parent.removeChild(el);
    else el.remove();
  } catch {}
}

/**
 * 中文说明：清理 root 下所有由历史详情“DOM 查找高亮”插入的 mark 标签。
 */
export function clearHistoryFindHighlights(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll(`mark[${HISTORY_FIND_MARK_ATTR}="${HISTORY_FIND_MARK_ATTR_VALUE}"]`));
  for (const m of marks) unwrapElement(m as HTMLElement);
  // 合并可能被拆分的文本节点，尽量恢复 DOM 结构的可读性
  try {
    root.normalize();
  } catch {}
  try {
    delete (root as HTMLElement).dataset.historyFindActiveId;
  } catch {}
}

/**
 * 中文说明：判断是否应跳过该 TextNode（避免高亮输入框、按钮等交互元素内文字）。
 */
function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  // 说明：防御性跳过，正常情况下我们只扫描 data-history-search-scope 区域
  const skip = parent.closest("button,input,textarea,select,option,[contenteditable='true'],[aria-hidden='true']");
  return !!skip;
}

/**
 * 中文说明：收集某个容器内的所有可搜索文本节点（按 DOM 顺序）。
 * 注意：必须先收集后替换，否则在遍历过程中插入 mark 会干扰 TreeWalker。
 */
function collectSearchableTextNodes(container: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (n) => {
        const t = n as Text;
        const v = t.nodeValue || "";
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        if (shouldSkipTextNode(t)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let cur = walker.nextNode();
  while (cur) {
    nodes.push(cur as Text);
    cur = walker.nextNode();
  }

  return nodes;
}

/**
 * 中文说明：查找所有匹配位置（不支持重叠匹配；与旧版 includes/indexOf 语义一致）。
 */
function findAllIndices(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/**
 * 中文说明：对单个 TextNode 进行范围包裹（多次命中时采用“从后往前”替换以避免偏移失效）。
 */
function wrapMatchesInTextNode(args: {
  node: Text;
  query: string;
  caseSensitive: boolean;
  messageKey: string;
  matchIdPrefix: string;
  nextIndex: number;
}): { matches: HistoryDomMatch[]; used: number } {
  const { node, query, caseSensitive, messageKey, matchIdPrefix, nextIndex } = args;
  const raw = node.nodeValue || "";
  const q = String(query || "");
  if (!raw || !q) return { matches: [], used: 0 };

  const haystack = caseSensitive ? raw : raw.toLowerCase();
  const needle = caseSensitive ? q : q.toLowerCase();
  const indices = findAllIndices(haystack, needle);
  if (indices.length === 0) return { matches: [], used: 0 };

  // 先分配 ID，确保结果稳定且按“从前到后”编号
  const ids = indices.map((_, i) => `${matchIdPrefix}${messageKey}-t${nextIndex + i}`);
  const wrapped: HistoryDomMatch[] = [];

  for (let i = indices.length - 1; i >= 0; i -= 1) {
    const start = indices[i];
    const end = start + needle.length;
    try {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);

      const mark = document.createElement("mark");
      mark.setAttribute(HISTORY_FIND_MARK_ATTR, HISTORY_FIND_MARK_ATTR_VALUE);
      mark.setAttribute("data-match-id", ids[i]);
      mark.className = HISTORY_FIND_MARK_CLASS;

      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);

      wrapped.push({ id: ids[i], messageKey });
    } catch {}
  }

  wrapped.reverse();
  return { matches: wrapped, used: indices.length };
}

/**
 * 中文说明：在 root 内应用“历史详情查找高亮”，并返回按消息顺序排列的命中列表。
 * 该函数会先清理旧高亮，再重新计算与插入 mark。
 */
export function applyHistoryFindHighlights(options: HistoryFindOptions): HistoryDomMatch[] {
  const {
    root,
    query,
    messageSelector = "[data-history-message-key]",
    scopeSelector = "[data-history-search-scope]",
    matchIdPrefix = "hfind-",
    caseSensitive = false,
  } = options;

  const q = String(query || "").trim();
  clearHistoryFindHighlights(root);
  if (!q) return [];

  const messages = Array.from(root.querySelectorAll(messageSelector)) as HTMLElement[];
  const allMatches: HistoryDomMatch[] = [];

  for (const msgEl of messages) {
    const messageKey = String(msgEl.dataset.historyMessageKey || "");
    if (!messageKey) continue;

    const scopes = Array.from(msgEl.querySelectorAll(scopeSelector)) as HTMLElement[];
    const scanRoots = scopes.length > 0 ? scopes : [msgEl];

    let counter = 0;
    for (const scanRoot of scanRoots) {
      const textNodes = collectSearchableTextNodes(scanRoot);
      for (const node of textNodes) {
        const res = wrapMatchesInTextNode({
          node,
          query: q,
          caseSensitive,
          messageKey,
          matchIdPrefix,
          nextIndex: counter,
        });
        counter += res.used;
        if (res.matches.length > 0) allMatches.push(...res.matches);
      }
    }
  }

  return allMatches;
}

/**
 * 中文说明：设置当前激活的 match，用于切换“当前命中”的高亮样式。
 * 若 activeMatchId 为空或对应元素不存在，则会清除激活态。
 */
export function setActiveHistoryFindMatch(root: HTMLElement, activeMatchId?: string | null): void {
  const next = String(activeMatchId || "");
  const prev = String(root.dataset.historyFindActiveId || "");
  if (prev && prev !== next) {
    const prevSel = `mark[${HISTORY_FIND_MARK_ATTR}="${HISTORY_FIND_MARK_ATTR_VALUE}"][data-match-id="${escapeForAttributeSelector(prev)}"]`;
    const prevEl = root.querySelector(prevSel) as HTMLElement | null;
    if (prevEl) prevEl.className = HISTORY_FIND_MARK_CLASS;
  }

  if (next) {
    const nextSel = `mark[${HISTORY_FIND_MARK_ATTR}="${HISTORY_FIND_MARK_ATTR_VALUE}"][data-match-id="${escapeForAttributeSelector(next)}"]`;
    const nextEl = root.querySelector(nextSel) as HTMLElement | null;
    if (nextEl) {
      nextEl.className = HISTORY_FIND_MARK_ACTIVE_CLASS;
      root.dataset.historyFindActiveId = next;
      return;
    }
  }

  delete root.dataset.historyFindActiveId;
}
