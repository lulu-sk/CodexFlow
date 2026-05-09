// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitLogItem } from "./types";

export type LaneEdge = {
  from: number;
  to: number;
  kind: "parent";
};

export type LaneCell = {
  lane: number;
  edges: LaneEdge[];
  passThrough: number[];
  hasIncoming: boolean;
  hasOutgoing: boolean;
  maxLane: number;
};

const LANE_COLORS = [
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#3b82f6",
  "#ec4899",
  "#22c55e",
  "#f97316",
  "#06b6d4",
];

/**
 * 获取稳定 lane 颜色。
 */
export function getLaneColor(lane: number): string {
  const idx = Math.abs(Math.floor(lane || 0)) % LANE_COLORS.length;
  return LANE_COLORS[idx];
}

/**
 * 寻找第一个空闲 lane，下标越小优先级越高。
 */
function allocateLane(active: Array<string | null>): number {
  const freeIdx = active.findIndex((value) => value === null);
  if (freeIdx >= 0) return freeIdx;
  active.push(null);
  return active.length - 1;
}

/**
 * 将重复出现的 commit 从旧 lane 移除，并设置到目标 lane。
 */
function placeCommitOnLane(active: Array<string | null>, commitHash: string, lane: number): void {
  for (let idx = 0; idx < active.length; idx += 1) {
    if (idx === lane) continue;
    if (active[idx] === commitHash) active[idx] = null;
  }
  active[lane] = commitHash;
}

/**
 * 删除尾部空 lane，避免图谱宽度无意义膨胀。
 */
function trimTrailingLanes(active: Array<string | null>): void {
  while (active.length > 0 && active[active.length - 1] === null) active.pop();
}

/**
 * 为提交列表计算 lane 与连线信息，用于图谱列绘制。
 * 设计目标：
 * 1) 保持主父提交尽量直线下沉；
 * 2) 合并父提交分配到稳定 lane；
 * 3) 输出“过路线”数据，让非当前提交 lane 仍可连续显示。
 */
export function buildLaneCells(items: GitLogItem[]): LaneCell[] {
  const cells: LaneCell[] = [];
  const active: Array<string | null> = [];

  for (const item of items) {
    const hash = String(item.hash || "").trim();
    if (!hash) {
      cells.push({
        lane: 0,
        edges: [],
        passThrough: [],
        hasIncoming: false,
        hasOutgoing: false,
        maxLane: 0,
      });
      continue;
    }

    let lane = active.findIndex((value) => value === hash);
    const hasIncoming = lane >= 0;
    if (lane < 0) lane = allocateLane(active);

    const passThrough: number[] = [];
    for (let idx = 0; idx < active.length; idx += 1) {
      if (idx === lane) continue;
      if (active[idx]) passThrough.push(idx);
    }

    const next = active.slice();
    next[lane] = null;

    const edges: LaneEdge[] = [];
    const parents = Array.isArray(item.parents) ? item.parents.filter(Boolean) : [];
    for (let idx = 0; idx < parents.length; idx += 1) {
      const parent = String(parents[idx] || "").trim();
      if (!parent) continue;

      let targetLane = -1;
      if (idx === 0) {
        targetLane = lane;
      } else {
        targetLane = next.findIndex((value) => value === parent);
        if (targetLane < 0) targetLane = allocateLane(next);
      }

      placeCommitOnLane(next, parent, targetLane);
      edges.push({ from: lane, to: targetLane, kind: "parent" });
    }

    trimTrailingLanes(next);
    let maxLane = lane;
    for (const v of passThrough) if (v > maxLane) maxLane = v;
    for (const edge of edges) {
      if (edge.from > maxLane) maxLane = edge.from;
      if (edge.to > maxLane) maxLane = edge.to;
    }
    for (let idx = 0; idx < next.length; idx += 1) {
      if (next[idx] && idx > maxLane) maxLane = idx;
    }

    cells.push({
      lane,
      edges,
      passThrough,
      hasIncoming,
      hasOutgoing: parents.length > 0,
      maxLane,
    });

    active.length = 0;
    active.push(...next);
  }

  return cells;
}
