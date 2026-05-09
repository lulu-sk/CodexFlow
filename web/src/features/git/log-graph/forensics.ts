// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitLogItem } from "../types";
import { GitLogGraphCell } from "./cell";
import type { GitGraphCell } from "./model";
import { buildGitLogVisiblePack } from "./visible-pack";

export type GitLogGraphForensicsLine = {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  stroke?: string;
  clipPath?: string;
  strokeDasharray?: string;
};

export type GitLogGraphForensicsPath = {
  d?: string;
  stroke?: string;
};

export type GitLogGraphForensicsSvg = {
  markup: string;
  clipPathIds: string[];
  lines: GitLogGraphForensicsLine[];
  paths: GitLogGraphForensicsPath[];
};

export type GitLogGraphForensicsTrack = {
  lane: number;
  incomingFromLane: number;
  incomingFromLanes: number[];
  outgoingToLane?: number;
  sourceLane?: number;
  targetLane?: number;
  hash?: string;
  sourceHash?: string;
  incomingTerminal?: boolean;
  incomingArrow?: boolean;
  outgoingTerminal?: boolean;
  outgoingArrow?: boolean;
};

export type GitLogGraphForensicsEdge = {
  from: number;
  to: number;
  sourceLane?: number;
  targetLane?: number;
  targetHash?: string;
  sourceHash?: string;
  terminal?: boolean;
  arrow?: boolean;
  style: "solid" | "dashed";
};

export type GitLogGraphForensicsRow = {
  rowIndex: number;
  hash: string;
  shortHash: string;
  authorDate: string;
  subject: string;
  decorations: string;
  lane: number;
  incomingFromLane: number | null;
  incomingFromLanes: number[];
  tracks: GitLogGraphForensicsTrack[];
  edges: GitLogGraphForensicsEdge[];
  svg: GitLogGraphForensicsSvg;
};

export type GitLogGraphForensicsReport = {
  totalRows: number;
  maxLane: number;
  graphColumnWidth: number;
  rowHeight: number;
  start: number;
  end: number;
  focusHashes: string[];
  focusSubjects: string[];
  rows: GitLogGraphForensicsRow[];
};

export type GitLogGraphForensicsReportOptions = {
  items: GitLogItem[];
  graphItems?: GitLogItem[];
  rowHeight?: number;
  focusHashes?: string[];
  focusSubjects?: string[];
  radius?: number;
  start?: number;
  end?: number;
};

/**
 * 把 `git log --pretty` 的 NUL/RS 原始输出解析成图谱输入项，供取证脚本和测试共用。
 */
export function parseGitLogForensicsItems(raw: string): GitLogItem[] {
  return String(raw || "")
    .split("\u001e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", parentsRaw = "", authorName = "", authorEmail = "", authorDate = "", subject = "", decorations = ""] = record.split("\u0000");
      const normalizedHash = String(hash || "").trim();
      return {
        hash: normalizedHash,
        shortHash: normalizedHash.slice(0, 8),
        parents: String(parentsRaw || "")
          .split(" ")
          .map((parent) => String(parent || "").trim())
          .filter(Boolean),
        authorName: String(authorName || ""),
        authorEmail: String(authorEmail || ""),
        authorDate: String(authorDate || ""),
        subject: String(subject || ""),
        decorations: String(decorations || ""),
      };
    })
    .filter((item) => item.hash);
}

/**
 * 基于关注哈希或标题计算取证窗口，便于把真实日志缩到截图对应的小区间。
 */
export function resolveGitLogGraphForensicsWindow(args: {
  items: GitLogItem[];
  focusHashes?: string[];
  focusSubjects?: string[];
  radius?: number;
  start?: number;
  end?: number;
}): { start: number; end: number } {
  if (Number.isFinite(args.start) && Number.isFinite(args.end)) {
    const start = clampGitLogGraphForensicsIndex(Number(args.start), args.items.length);
    const end = clampGitLogGraphForensicsIndex(Number(args.end), args.items.length);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end) + 1,
    };
  }

  const focusHashes = normalizeGitLogGraphForensicsTokens(args.focusHashes);
  const focusSubjects = normalizeGitLogGraphForensicsTokens(args.focusSubjects);
  const radius = Math.max(0, Number(args.radius ?? 2));
  const matches: number[] = [];

  args.items.forEach((item, index) => {
    const hash = String(item.hash || "").trim().toLowerCase();
    const subject = String(item.subject || "");
    if (focusHashes.some((token) => hash.startsWith(token)))
      matches.push(index);
    else if (focusSubjects.some((token) => subject.includes(token)))
      matches.push(index);
  });

  if (matches.length <= 0)
    return { start: 0, end: args.items.length };

  const start = Math.max(0, Math.min(...matches) - radius);
  const end = Math.min(args.items.length, Math.max(...matches) + radius + 1);
  return { start, end };
}

/**
 * 构建图谱取证报告，统一输出模型层 lane/edge 与渲染层 SVG 片段，便于修前修后对比。
 */
export function buildGitLogGraphForensicsReport(args: GitLogGraphForensicsReportOptions): GitLogGraphForensicsReport {
  const rowHeight = Number(args.rowHeight ?? 32);
  const pack = buildGitLogVisiblePack({
    items: Array.isArray(args.items) ? args.items : [],
    graphItems: Array.isArray(args.graphItems) ? args.graphItems : args.items,
    fileHistoryMode: false,
  });
  const window = resolveGitLogGraphForensicsWindow({
    items: pack.items,
    focusHashes: args.focusHashes,
    focusSubjects: args.focusSubjects,
    radius: args.radius,
    start: args.start,
    end: args.end,
  });

  return {
    totalRows: pack.items.length,
    maxLane: pack.maxLane,
    graphColumnWidth: pack.graphColumnWidth,
    rowHeight,
    start: window.start,
    end: window.end,
    focusHashes: normalizeGitLogGraphForensicsTokens(args.focusHashes),
    focusSubjects: normalizeGitLogGraphForensicsTokens(args.focusSubjects),
    rows: pack.items.slice(window.start, window.end).map((item, offset) => {
      const rowIndex = window.start + offset;
      const cell = pack.graphCells[rowIndex];
      return buildGitLogGraphForensicsRow(item, cell, rowIndex, rowHeight);
    }),
  };
}

/**
 * 把单行提交与图谱单元压成便于比对的结构化证据。
 */
function buildGitLogGraphForensicsRow(
  item: GitLogItem,
  cell: GitGraphCell | undefined,
  rowIndex: number,
  rowHeight: number,
): GitLogGraphForensicsRow {
  return {
    rowIndex,
    hash: item.hash,
    shortHash: item.shortHash,
    authorDate: item.authorDate,
    subject: item.subject,
    decorations: item.decorations,
    lane: Number(cell?.lane ?? 0),
    incomingFromLane: cell?.incomingFromLane ?? null,
    incomingFromLanes: Array.isArray(cell?.incomingFromLanes) ? [...cell!.incomingFromLanes!] : [],
    tracks: (cell?.tracks || []).map((track) => ({
      lane: track.lane,
      incomingFromLane: track.incomingFromLane,
      incomingFromLanes: Array.isArray(track.incomingFromLanes) ? [...track.incomingFromLanes] : [],
      outgoingToLane: track.outgoingToLane,
      sourceLane: track.sourceLane,
      targetLane: track.targetLane,
      hash: track.hash,
      sourceHash: track.sourceHash,
      incomingTerminal: track.incomingTerminal,
      incomingArrow: track.incomingArrow,
      outgoingTerminal: track.outgoingTerminal,
      outgoingArrow: track.outgoingArrow,
    })),
    edges: (cell?.edges || []).map((edge) => ({
      from: edge.from,
      to: edge.to,
      sourceLane: edge.sourceLane,
      targetLane: edge.targetLane,
      targetHash: edge.targetHash,
      sourceHash: edge.sourceHash,
      terminal: edge.terminal,
      arrow: edge.arrow,
      style: edge.style,
    })),
    svg: renderGitLogGraphForensicsSvg(cell, rowHeight),
  };
}

/**
 * 把单行图谱渲染成静态 SVG，并解析出线段、箭头与 clipPath，作为渲染层证据。
 */
function renderGitLogGraphForensicsSvg(cell: GitGraphCell | undefined, rowHeight: number): GitLogGraphForensicsSvg {
  const markup = renderToStaticMarkup(React.createElement(GitLogGraphCell, {
    cell,
    selected: false,
    rowHeight,
  }));
  return {
    markup,
    clipPathIds: Array.from(markup.matchAll(/<clipPath[^>]*id="([^"]+)"/g)).map((match) => match[1] || ""),
    lines: Array.from(markup.matchAll(/<line\s+([^>]+?)(?:\/>|><\/line>)/g)).map((match) => {
      const attributes = parseGitLogGraphForensicsAttributes(match[1] || "");
      return {
        x1: parseGitLogGraphForensicsNumber(attributes.x1),
        y1: parseGitLogGraphForensicsNumber(attributes.y1),
        x2: parseGitLogGraphForensicsNumber(attributes.x2),
        y2: parseGitLogGraphForensicsNumber(attributes.y2),
        stroke: attributes.stroke,
        clipPath: attributes["clip-path"],
        strokeDasharray: attributes["stroke-dasharray"],
      };
    }),
    paths: Array.from(markup.matchAll(/<path\s+([^>]+?)(?:\/>|><\/path>)/g)).map((match) => {
      const attributes = parseGitLogGraphForensicsAttributes(match[1] || "");
      return {
        d: attributes.d,
        stroke: attributes.stroke,
      };
    }),
  };
}

/**
 * 解析单个 SVG 标签的属性字典，供取证报告提取线段几何使用。
 */
function parseGitLogGraphForensicsAttributes(fragment: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of fragment.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g))
    result[match[1] || ""] = match[2] || "";
  return result;
}

/**
 * 把 SVG 属性中的数字转成数值，非数字时保持 `undefined`，避免报告里混入 `NaN`。
 */
function parseGitLogGraphForensicsNumber(value: string | undefined): number | undefined {
  if (value == null || value === "")
    return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 规范化 focus token，统一去空格、转小写，避免 CLI 参数因大小写或空字符串失效。
 */
function normalizeGitLogGraphForensicsTokens(tokens?: string[]): string[] {
  return Array.isArray(tokens)
    ? tokens
        .map((token) => String(token || "").trim().toLowerCase())
        .filter(Boolean)
    : [];
}

/**
 * 把显式传入的窗口边界裁剪到合法范围，避免越界导致报告构建失败。
 */
function clampGitLogGraphForensicsIndex(index: number, total: number): number {
  if (!Number.isFinite(index))
    return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(index)));
}
