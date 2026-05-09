// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { CommitPanelRenderRow } from "./types";

export type CommitTreeNavigationResult = {
  focusRowKey: string;
  toggleNodeKey?: string;
  toggleGroupKey?: string;
};

export type CommitSpeedSearchableRow = {
  key: string;
  textPresentation: string;
};

export type CommitSpeedSearchMatchRange = {
  start: number;
  end: number;
};

export type CommitSpeedSearchDirection = "next" | "previous";

/**
 * 优先执行连续子串命中；若失败则按字符顺序做宽松匹配，并把连续命中片段合并成稳定区间。
 */
export function findCommitSpeedSearchRanges(args: {
  text: string;
  query: string;
}): CommitSpeedSearchMatchRange[] | null {
  const text = String(args.text || "");
  const query = String(args.query || "").trim();
  if (!text || !query) return null;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const exactIndex = lowerText.indexOf(lowerQuery);
  if (exactIndex >= 0) {
    return [{ start: exactIndex, end: exactIndex + lowerQuery.length }];
  }
  const ranges: CommitSpeedSearchMatchRange[] = [];
  let searchCursor = 0;
  for (const queryChar of lowerQuery) {
    const nextIndex = lowerText.indexOf(queryChar, searchCursor);
    if (nextIndex < 0) return null;
    const lastRange = ranges[ranges.length - 1];
    if (lastRange && lastRange.end === nextIndex) {
      lastRange.end += 1;
    } else {
      ranges.push({ start: nextIndex, end: nextIndex + 1 });
    }
    searchCursor = nextIndex + 1;
  }
  return ranges.length > 0 ? ranges : null;
}

/**
 * 按当前可见树行解析提交树方向键导航结果，统一复用在主树与 Browse 树。
 */
export function navigateCommitTreeRows(args: {
  rows: CommitPanelRenderRow[];
  currentRowKey: string;
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";
  isExpanded: (rowKey: string) => boolean;
  findParentRowKey: (rowKey: string) => string;
}): CommitTreeNavigationResult | null {
  if (args.rows.length === 0) return null;
  const currentIndex = Math.max(0, args.rows.findIndex((row) => row.key === args.currentRowKey));
  const currentRow = args.rows[currentIndex];
  if (!currentRow) return null;
  if (args.key === "Home") return { focusRowKey: args.rows[0]?.key || args.currentRowKey };
  if (args.key === "End") return { focusRowKey: args.rows[args.rows.length - 1]?.key || args.currentRowKey };
  if (args.key === "ArrowUp") return { focusRowKey: args.rows[Math.max(0, currentIndex - 1)]?.key || args.currentRowKey };
  if (args.key === "ArrowDown") return { focusRowKey: args.rows[Math.min(args.rows.length - 1, currentIndex + 1)]?.key || args.currentRowKey };
  if (currentRow.kind === "group") {
    if (args.key === "ArrowRight") {
      if (!args.isExpanded(currentRow.key)) {
        return {
          focusRowKey: currentRow.key,
          toggleGroupKey: currentRow.group.key,
        };
      }
      const nextRow = args.rows[currentIndex + 1];
      return nextRow ? { focusRowKey: nextRow.key } : { focusRowKey: currentRow.key };
    }
    if (args.key === "ArrowLeft") {
      if (args.isExpanded(currentRow.key)) {
        return {
          focusRowKey: currentRow.key,
          toggleGroupKey: currentRow.group.key,
        };
      }
      return { focusRowKey: currentRow.key };
    }
    return null;
  }
  if (currentRow.node.isFile) return null;
  if (args.key === "ArrowRight") {
    if (!args.isExpanded(currentRow.node.key)) {
      return {
        focusRowKey: currentRow.key,
        toggleNodeKey: currentRow.node.key,
      };
    }
    const nextRow = args.rows[currentIndex + 1];
    return nextRow ? { focusRowKey: nextRow.key } : { focusRowKey: currentRow.key };
  }
  if (args.key === "ArrowLeft") {
    if (args.isExpanded(currentRow.node.key)) {
      return {
        focusRowKey: currentRow.key,
        toggleNodeKey: currentRow.node.key,
      };
    }
    return { focusRowKey: args.findParentRowKey(currentRow.key) || currentRow.key };
  }
  return null;
}

/**
 * 按统一文本表示执行 speed search；优先从当前行之后找命中，再回绕到顶部。
 */
export function findCommitSpeedSearchMatch(args: {
  rows: CommitSpeedSearchableRow[];
  query: string;
  currentRowKey: string;
  direction?: CommitSpeedSearchDirection;
}): string {
  const query = String(args.query || "").trim();
  if (!query) return args.currentRowKey;
  const texts = args.rows.map((row) => ({ key: row.key, text: String(row.textPresentation || "") }));
  const startIndex = Math.max(0, texts.findIndex((row) => row.key === args.currentRowKey));
  const direction = args.direction || "next";
  const ordered = direction === "previous"
    ? [...texts.slice(0, startIndex).reverse(), ...texts.slice(startIndex).reverse()]
    : [...texts.slice(startIndex + 1), ...texts.slice(0, startIndex + 1)];
  const hit = ordered.find((row) => !!findCommitSpeedSearchRanges({ text: row.text, query }));
  return hit?.key || args.currentRowKey;
}

/**
 * 按屏幕显示顺序导出已选树行文本，用于提交树 copy provider。
 */
export function buildCommitTreeCopyText(args: {
  rows: CommitPanelRenderRow[];
  selectedRowKeys: string[];
}): string {
  const selected = new Set(args.selectedRowKeys);
  return args.rows
    .filter((row) => selected.has(row.key))
    .map((row) => String(row.textPresentation || "").trim())
    .filter(Boolean)
    .join("\n");
}
