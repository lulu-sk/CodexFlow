// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { CSSProperties } from "react";
import { resolveGitText } from "./git-i18n";

export type GitLogColumnId = "subject" | "author" | "date" | "hash" | "refs";

export type GitLogColumnDefinition = {
  id: GitLogColumnId;
  label: string;
  minWidth: number;
  defaultWidth: number;
  grow?: boolean;
};

export type GitLogColumnLayout = {
  order: GitLogColumnId[];
  widths: Record<GitLogColumnId, number>;
  autoFit: Record<GitLogColumnId, boolean>;
};

const GIT_LOG_COLUMN_LAYOUT_STORAGE_KEY = "cf.gitWorkbench.logColumns.v3";
const PREVIOUS_GIT_LOG_COLUMN_LAYOUT_STORAGE_KEY = "cf.gitWorkbench.logColumns.v2";
const LEGACY_GIT_LOG_COLUMN_LAYOUT_STORAGE_KEY = "cf.gitWorkbench.logColumns.v1";

export const GIT_LOG_COLUMN_DEFINITIONS: GitLogColumnDefinition[] = [
  { id: "subject", get label() { return resolveGitText("log.columns.subject", "提交信息"); }, minWidth: 212, defaultWidth: 368, grow: true },
  { id: "author", get label() { return resolveGitText("log.columns.author", "作者"); }, minWidth: 56, defaultWidth: 104 },
  { id: "date", get label() { return resolveGitText("log.columns.date", "时间"); }, minWidth: 68, defaultWidth: 96 },
  { id: "hash", get label() { return resolveGitText("log.columns.hash", "哈希"); }, minWidth: 60, defaultWidth: 82 },
  { id: "refs", get label() { return resolveGitText("log.columns.refs", "引用"); }, minWidth: 84, defaultWidth: 128 },
];

const DEFAULT_ORDER: GitLogColumnId[] = GIT_LOG_COLUMN_DEFINITIONS.map((one) => one.id);
const DEFAULT_AUTO_FIT: Record<GitLogColumnId, boolean> = {
  subject: false,
  author: true,
  date: true,
  hash: true,
  refs: true,
};

/**
 * 按列定义夹紧宽度，避免过窄或过宽导致日志表格抖动。
 */
function clampGitLogColumnWidth(column: GitLogColumnDefinition, nextWidth: number, maxWidth = 720): number {
  return Math.max(column.minWidth, Math.min(maxWidth, Math.round(Number(nextWidth) || column.defaultWidth)));
}

/**
 * 判断指定列默认是否启用内容自适应宽度。
 */
function getGitLogColumnDefaultAutoFit(columnId: GitLogColumnId): boolean {
  return DEFAULT_AUTO_FIT[columnId] === true;
}

/**
 * 粗略估算日志列文本像素宽度，避免引入额外 DOM 测量开销。
 */
function estimateGitLogTextWidth(text: string): number {
  let width = 0;
  for (const char of String(text || "")) {
    const code = char.charCodeAt(0);
    if (code <= 0x7f) {
      width += /[\s./:_-]/.test(char) ? 4 : 6;
      continue;
    }
    width += 10;
  }
  return width;
}

/**
 * 按列 ID 建立定义映射，便于后续快速查询宽度和最小值。
 */
export function getGitLogColumnDefinitionMap(): Map<GitLogColumnId, GitLogColumnDefinition> {
  return new Map(GIT_LOG_COLUMN_DEFINITIONS.map((one) => [one.id, one] as const));
}

/**
 * 构建默认日志列布局，作为首次进入或缓存损坏时的兜底值。
 */
export function createDefaultGitLogColumnLayout(): GitLogColumnLayout {
  const widths = {} as Record<GitLogColumnId, number>;
  const autoFit = {} as Record<GitLogColumnId, boolean>;
  for (const column of GIT_LOG_COLUMN_DEFINITIONS) {
    widths[column.id] = column.defaultWidth;
    autoFit[column.id] = getGitLogColumnDefaultAutoFit(column.id);
  }
  return {
    order: [...DEFAULT_ORDER],
    widths,
    autoFit,
  };
}

/**
 * 归一化日志列布局，补齐缺失列并夹紧非法宽度，保证渲染稳定。
 */
export function normalizeGitLogColumnLayout(raw: Partial<GitLogColumnLayout> | null | undefined): GitLogColumnLayout {
  const fallback = createDefaultGitLogColumnLayout();
  const defs = getGitLogColumnDefinitionMap();
  const seen = new Set<GitLogColumnId>();
  const order: GitLogColumnId[] = [];
  for (const item of raw?.order || []) {
    const id = String(item || "").trim() as GitLogColumnId;
    if (!defs.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of DEFAULT_ORDER) {
    if (!seen.has(id)) order.push(id);
  }

  const widths = {} as Record<GitLogColumnId, number>;
  const autoFit = {} as Record<GitLogColumnId, boolean>;
  for (const column of GIT_LOG_COLUMN_DEFINITIONS) {
    const input = Number(raw?.widths?.[column.id]);
    widths[column.id] = clampGitLogColumnWidth(column, Number.isFinite(input) ? input : fallback.widths[column.id]);
    const rawAutoFit = raw?.autoFit?.[column.id];
    if (typeof rawAutoFit === "boolean") {
      autoFit[column.id] = rawAutoFit;
      continue;
    }
    if (Number.isFinite(input) && Math.round(input) !== fallback.widths[column.id] && getGitLogColumnDefaultAutoFit(column.id)) {
      autoFit[column.id] = false;
      continue;
    }
    autoFit[column.id] = fallback.autoFit[column.id];
  }

  return {
    order,
    widths,
    autoFit,
  };
}

/**
 * 从本地缓存读取日志列布局，保持列顺序与宽度跨会话一致。
 */
export function loadGitLogColumnLayout(): GitLogColumnLayout {
  if (typeof window === "undefined") return createDefaultGitLogColumnLayout();
  try {
    const raw = window.localStorage.getItem(GIT_LOG_COLUMN_LAYOUT_STORAGE_KEY);
    if (raw) return normalizeGitLogColumnLayout(JSON.parse(raw || "{}") as Partial<GitLogColumnLayout>);
    const rawPrevious = window.localStorage.getItem(PREVIOUS_GIT_LOG_COLUMN_LAYOUT_STORAGE_KEY);
    if (rawPrevious) return migrateLegacyGitLogColumnLayout(JSON.parse(rawPrevious || "{}") as Partial<GitLogColumnLayout>);
    const rawLegacy = window.localStorage.getItem(LEGACY_GIT_LOG_COLUMN_LAYOUT_STORAGE_KEY);
    if (!rawLegacy) return createDefaultGitLogColumnLayout();
    return migrateLegacyGitLogColumnLayout(JSON.parse(rawLegacy || "{}") as Partial<GitLogColumnLayout>);
  } catch {
    return createDefaultGitLogColumnLayout();
  }
}

/**
 * 迁移旧版日志列缓存，将历史默认宽度升级为当前更紧凑的配置，并保留用户手动拖拽结果。
 */
function migrateLegacyGitLogColumnLayout(raw: Partial<GitLogColumnLayout>): GitLogColumnLayout {
  const normalized = normalizeGitLogColumnLayout(raw);
  const defaults = createDefaultGitLogColumnLayout();
  const knownLegacyDefaultWidths: Record<GitLogColumnId, number[]> = {
    subject: [420, 396, 384],
    author: [140, 124, 112],
    date: [132, 118, 108],
    hash: [104, 96, 88],
    refs: [220, 168, 144],
  };
  const widths = { ...normalized.widths };
  const autoFit = { ...normalized.autoFit };
  for (const column of GIT_LOG_COLUMN_DEFINITIONS) {
    if (!knownLegacyDefaultWidths[column.id].includes(widths[column.id])) continue;
    widths[column.id] = defaults.widths[column.id];
    autoFit[column.id] = defaults.autoFit[column.id];
  }
  return normalizeGitLogColumnLayout({
    ...normalized,
    widths,
    autoFit,
  });
}

/**
 * 将日志列布局写入本地缓存；失败时静默忽略，避免影响主流程。
 */
export function saveGitLogColumnLayout(layout: GitLogColumnLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GIT_LOG_COLUMN_LAYOUT_STORAGE_KEY, JSON.stringify(normalizeGitLogColumnLayout(layout)));
  } catch {
    // 忽略缓存写入失败
  }
}

/**
 * 返回某一列在当前布局下的弹性样式，模拟 IDEA 日志表格的“主列自适应、其余列可收缩”。
 */
export function buildGitLogColumnStyle(layout: GitLogColumnLayout, columnId: GitLogColumnId, preferredWidth?: number): CSSProperties {
  const definition = GIT_LOG_COLUMN_DEFINITIONS.find((one) => one.id === columnId) || GIT_LOG_COLUMN_DEFINITIONS[0];
  const width = resolveGitLogColumnWidth(layout, columnId, preferredWidth);
  if (definition.grow) {
    return {
      minWidth: definition.minWidth,
      flex: `1 1 ${width}px`,
      flexBasis: width,
    };
  }
  return {
    minWidth: definition.minWidth,
    flex: `0 1 ${width}px`,
    flexBasis: width,
    width,
  };
}

/**
 * 判断某一列在当前布局下是否仍启用自动宽度。
 */
export function isGitLogColumnAutoFit(layout: GitLogColumnLayout, columnId: GitLogColumnId): boolean {
  const normalized = normalizeGitLogColumnLayout(layout);
  return normalized.autoFit[columnId] !== false;
}

/**
 * 按当前内容估算日志列建议宽度，用于作者/时间/哈希等短列自动收敛空白。
 */
export function estimateGitLogColumnWidth(columnId: GitLogColumnId, samples: string[]): number {
  const definition = GIT_LOG_COLUMN_DEFINITIONS.find((one) => one.id === columnId) || GIT_LOG_COLUMN_DEFINITIONS[0];
  const maxTextWidth = [definition.label, ...samples]
    .map((one) => estimateGitLogTextWidth(one))
    .reduce((max, current) => Math.max(max, current), 0);
  const paddedWidth = maxTextWidth + (columnId === "hash" ? 16 : columnId === "refs" ? 18 : 20);
  const maxWidth = columnId === "author" ? 136 : columnId === "date" ? 100 : columnId === "hash" ? 84 : columnId === "refs" ? 132 : 720;
  return clampGitLogColumnWidth(definition, paddedWidth, maxWidth);
}

/**
 * 解析日志列最终生效宽度；自动列优先取内容估算值，手动列保持用户拖拽结果。
 */
export function resolveGitLogColumnWidth(layout: GitLogColumnLayout, columnId: GitLogColumnId, preferredWidth?: number): number {
  const normalized = normalizeGitLogColumnLayout(layout);
  const definition = GIT_LOG_COLUMN_DEFINITIONS.find((one) => one.id === columnId) || GIT_LOG_COLUMN_DEFINITIONS[0];
  if (normalized.autoFit[columnId] !== false && typeof preferredWidth === "number" && Number.isFinite(preferredWidth)) {
    return clampGitLogColumnWidth(definition, preferredWidth);
  }
  return clampGitLogColumnWidth(definition, normalized.widths[columnId]);
}

/**
 * 调整单列宽度，并按定义约束最小/最大值。
 */
export function resizeGitLogColumn(layout: GitLogColumnLayout, columnId: GitLogColumnId, nextWidth: number): GitLogColumnLayout {
  const normalized = normalizeGitLogColumnLayout(layout);
  const definition = GIT_LOG_COLUMN_DEFINITIONS.find((one) => one.id === columnId);
  if (!definition) return normalized;
  return {
    ...normalized,
    widths: {
      ...normalized.widths,
      [columnId]: clampGitLogColumnWidth(definition, nextWidth),
    },
    autoFit: {
      ...normalized.autoFit,
      [columnId]: false,
    },
  };
}

/**
 * 按拖拽结果重新排列日志列顺序，行为对齐 IDEA 的表头拖拽交换。
 */
export function moveGitLogColumn(layout: GitLogColumnLayout, sourceId: GitLogColumnId, targetId: GitLogColumnId): GitLogColumnLayout {
  if (sourceId === targetId) return normalizeGitLogColumnLayout(layout);
  const normalized = normalizeGitLogColumnLayout(layout);
  const order = [...normalized.order];
  const sourceIndex = order.indexOf(sourceId);
  const targetIndex = order.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return normalized;
  order.splice(sourceIndex, 1);
  order.splice(targetIndex, 0, sourceId);
  return {
    ...normalized,
    order,
  };
}
