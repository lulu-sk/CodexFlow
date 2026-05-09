// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitGraphCell } from "./model";

export const LOG_GRAPH_ROW_HEIGHT_BASE = 22;
export const LOG_GRAPH_RENDER_ROW_HEIGHT = 32;
export const LOG_GRAPH_LANE_WIDTH = 16;
export const LOG_GRAPH_TEXT_GAP = 2;
export const LOG_GRAPH_CIRCLE_RADIUS = 4;
export const LOG_GRAPH_LINE_WIDTH = 1.5;
export const LOG_GRAPH_SELECTED_LINE_WIDTH = 2.5;
export const LOG_GRAPH_BASE_WIDTH = LOG_GRAPH_LANE_WIDTH * 2 + LOG_GRAPH_TEXT_GAP;
export const LOG_GRAPH_X_OFFSET = LOG_GRAPH_LANE_WIDTH / 2;
export const LOG_GRAPH_HEAD_RADIUS_DELTA = 2;

type LogGraphRoundingMode = "floor" | "ceil" | "round";
type LogGraphParityMode = "odd" | "even";

/**
 * 按 IDEA `PaintParameters.scaleWithRowHeight` 的语义，把图谱尺寸随着实际行高同比缩放。
 */
export function scaleLogGraphMetric(value: number, rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return (value * rowHeight) / LOG_GRAPH_ROW_HEIGHT_BASE;
}

/**
 * 按指定舍入策略把值对齐到整数像素，语义贴近 IDEA `PaintUtil.alignToInt`。
 */
function alignLogGraphToPixel(value: number, roundingMode: LogGraphRoundingMode, parityMode?: LogGraphParityMode): number {
  let rounded = roundLogGraphPixel(value, parityMode && roundingMode === "round" ? "floor" : roundingMode);
  if (parityMode && resolveLogGraphParity(rounded) !== parityMode)
    rounded += roundingMode === "floor" ? -1 : 1;
  return rounded;
}

/**
 * 执行图谱像素对齐时使用的基础舍入逻辑。
 */
function roundLogGraphPixel(value: number, roundingMode: LogGraphRoundingMode): number {
  if (roundingMode === "ceil")
    return Math.ceil(value);
  if (roundingMode === "round")
    return Math.round(value);
  return Math.floor(value);
}

/**
 * 返回整数像素值的奇偶性，供 IDEA 风格的奇/偶对齐使用。
 */
function resolveLogGraphParity(value: number): LogGraphParityMode {
  return Math.abs(value % 2) === 0 ? "even" : "odd";
}

/**
 * 获取当前行高下的行中心。
 * Web 端这里必须与日志列表行盒的真实几何中心保持一致；若继续照搬 IDEA Swing 里的奇数像素对齐，
 * 在当前 `32px` 偶数行高下会把整张图谱统一上移 `1px`，导致节点与文本行心整体错位。
 */
export function resolveLogGraphRowCenter(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return rowHeight / 2;
}

/**
 * 获取当前行高下的 lane 宽度，对齐 IDEA `elementWidth = alignToInt(getElementWidth(rowHeight), FLOOR, ODD)`。
 */
export function resolveLogGraphLaneWidth(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(scaleLogGraphMetric(LOG_GRAPH_LANE_WIDTH, rowHeight), "floor", "odd");
}

/**
 * 获取当前行高下的单个 lane 的水平中心，保证列中心与 IDEA 的布局一致。
 */
export function resolveLogGraphLaneCenter(lane: number, rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return lane * resolveLogGraphLaneWidth(rowHeight) + resolveLogGraphXOffset(rowHeight);
}

/**
 * 获取当前行高下的图谱列中心偏移，对齐 IDEA `elementCenter = alignToInt(getElementWidth(rowHeight) / 2, FLOOR, null)`。
 */
export function resolveLogGraphXOffset(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(scaleLogGraphMetric(LOG_GRAPH_LANE_WIDTH, rowHeight) / 2, "floor");
}

/**
 * 获取当前行高下的普通线宽，对齐 IDEA `lineThickness = alignToInt(getLineThickness(rowHeight), FLOOR, ODD)`。
 */
export function resolveLogGraphLineWidth(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return Math.max(1, alignLogGraphToPixel(scaleLogGraphMetric(LOG_GRAPH_LINE_WIDTH, rowHeight), "floor", "odd"));
}

/**
 * 获取当前行高下的选中线宽，对齐 IDEA `selectedLineThickness` 的对齐与最小差值规则。
 */
export function resolveLogGraphSelectedLineWidth(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return Math.max(
    resolveLogGraphLineWidth(rowHeight) + 2,
    alignLogGraphToPixel(scaleLogGraphMetric(LOG_GRAPH_SELECTED_LINE_WIDTH, rowHeight), "floor", "odd"),
  );
}

/**
 * 获取当前行高下的节点圆直径，对齐 IDEA `circleDiameter = alignToInt(2 * getCircleRadius(rowHeight), FLOOR, ODD)`。
 */
export function resolveLogGraphCircleDiameter(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(scaleLogGraphMetric(LOG_GRAPH_CIRCLE_RADIUS * 2, rowHeight), "floor", "odd");
}

/**
 * 获取当前行高下的节点圆半径，对齐 IDEA `circleRadius = alignToInt(circleDiameter / 2, FLOOR, null)`。
 */
export function resolveLogGraphCircleRadius(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(resolveLogGraphCircleDiameter(rowHeight) / 2, "floor");
}

/**
 * 获取当前行高下的选中节点圆直径，对齐 IDEA `selectedCircleDiameter = circleDiameter + selectedLineThickness - lineThickness`。
 */
export function resolveLogGraphSelectedCircleDiameter(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return resolveLogGraphCircleDiameter(rowHeight) + resolveLogGraphSelectedLineWidth(rowHeight) - resolveLogGraphLineWidth(rowHeight);
}

/**
 * 获取当前行高下的选中节点圆半径，对齐 IDEA `selectedCircleRadius = alignToInt(selectedCircleDiameter / 2, FLOOR, null)`。
 */
export function resolveLogGraphSelectedCircleRadius(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(resolveLogGraphSelectedCircleDiameter(rowHeight) / 2, "floor");
}

/**
 * 获取当前行高下的图谱与文本间距，对齐 IDEA `PaintParameters.getGraphTextGap`。
 */
export function resolveLogGraphTextGap(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return scaleLogGraphMetric(LOG_GRAPH_TEXT_GAP, rowHeight);
}

/**
 * 获取当前行高下的 HEAD 节点外圈半径增量，对齐 IDEA `HeadNodePainter` 中的 `delta`。
 */
export function resolveLogGraphHeadRadiusDelta(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(scaleLogGraphMetric(LOG_GRAPH_HEAD_RADIUS_DELTA, rowHeight), "floor");
}

/**
 * 获取当前行高下的 HEAD 节点外圈直径，对齐 IDEA `outerCircleDiameter` 的计算方式。
 */
export function resolveLogGraphHeadOuterCircleDiameter(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(
    scaleLogGraphMetric((LOG_GRAPH_CIRCLE_RADIUS + LOG_GRAPH_HEAD_RADIUS_DELTA) * 2, rowHeight),
    "floor",
    "odd",
  );
}

/**
 * 获取当前行高下的 HEAD 节点外圈半径，对齐 IDEA `outerCircleRadius`。
 */
export function resolveLogGraphHeadOuterCircleRadius(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(resolveLogGraphHeadOuterCircleDiameter(rowHeight) / 2, "floor");
}

/**
 * 获取当前行高下的选中 HEAD 节点外圈直径，对齐 IDEA `selectedOuterCircleDiameter`。
 */
export function resolveLogGraphHeadSelectedOuterCircleDiameter(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return resolveLogGraphHeadOuterCircleDiameter(rowHeight) + resolveLogGraphSelectedLineWidth(rowHeight) - resolveLogGraphLineWidth(rowHeight);
}

/**
 * 获取当前行高下的选中 HEAD 节点外圈半径，对齐 IDEA `selectedOuterCircleRadius`。
 */
export function resolveLogGraphHeadSelectedOuterCircleRadius(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return alignLogGraphToPixel(resolveLogGraphHeadSelectedOuterCircleDiameter(rowHeight) / 2, "floor");
}

/**
 * 计算 Web 端单行 SVG 中，上/下半段跨行边的拼接边界，等价于 IDEA 完整边在相邻两行中心之间的中点。
 * 由于 Web 端每一行外层还带有 `border-b` 分隔线，若边界刚好卡在 `0 / rowHeight`，斜线会在接缝处显得断半截。
 * 这里额外向上下各延伸 `1px`，让相邻两行的半段在分隔线区域有稳定重叠。
 */
export function resolveLogGraphHalfEdgeBoundaryY(
  rowHeight: number,
  direction: "up" | "down",
): number {
  const rowCenter = resolveLogGraphRowCenter(rowHeight);
  const overlap = resolveLogGraphHalfEdgeOverlap(rowHeight);
  return direction === "down"
    ? rowCenter + rowHeight / 2 + overlap
    : rowCenter - rowHeight / 2 - overlap;
}

/**
 * 返回跨行半段在接缝区域需要额外覆盖的像素，避免被列表分隔线切断。
 */
function resolveLogGraphHalfEdgeOverlap(rowHeight: number): number {
  return Math.max(1, Math.ceil(resolveLogGraphLineWidth(rowHeight)));
}

/**
 * 计算 terminal edge 在当前行内的收口间距，对齐 IDEA `circleRadius / 2 + 1`。
 */
export function resolveLogGraphTerminalGap(rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return resolveLogGraphCircleRadius(rowHeight) / 2 + 1;
}

/**
 * 仅按当前行实际可见的节点、轨道和边计算最右侧 lane，语义对齐 IDEA `GraphCommitCellUtil`
 * “只消费本行 print elements，不预留未来行空白”的宽度判定方式。
 * 由于 Web 端把跨行斜线拆成上下半段，这里要按“当前行真实画出的半段”估算右边界，而不是直接吃下一行的完整目标列。
 */
export function resolveLogGraphVisibleMaxLane(cell?: GitGraphCell | null): number {
  let maxLane = Math.max(0, Number(cell?.lane ?? 0));
  for (const track of cell?.tracks || []) {
    if (track.lane > maxLane) maxLane = track.lane;
    if (Number.isFinite(track.outgoingToLane)) {
      const outgoingVisibleLane = resolveLogGraphOutgoingVisibleMaxLane(track.lane, Number(track.outgoingToLane));
      if (outgoingVisibleLane > maxLane) maxLane = outgoingVisibleLane;
    }
    for (const incomingLane of resolveLogGraphIncomingLaneSource(track.incomingFromLane, track.incomingFromLanes)) {
      const incomingVisibleLane = resolveLogGraphIncomingVisibleMaxLane(incomingLane, track.lane);
      if (incomingVisibleLane > maxLane) maxLane = incomingVisibleLane;
    }
  }
  for (const incomingLane of resolveLogGraphIncomingLaneSource(cell?.incomingFromLane, cell?.incomingFromLanes)) {
    const incomingVisibleLane = resolveLogGraphIncomingVisibleMaxLane(incomingLane, Number(cell?.lane ?? 0));
    if (incomingVisibleLane > maxLane) maxLane = incomingVisibleLane;
  }
  for (const edge of cell?.edges || []) {
    if (edge.from > maxLane) maxLane = edge.from;
    const outgoingVisibleLane = resolveLogGraphOutgoingVisibleMaxLane(edge.from, edge.to);
    if (outgoingVisibleLane > maxLane) maxLane = outgoingVisibleLane;
  }
  return maxLane;
}

/**
 * 归一化当前单元可见的入射 lane 列表，兼容旧的单值字段与新的多值字段。
 */
function resolveLogGraphIncomingLaneSource(incomingFromLane?: number | null, incomingFromLanes?: number[]): number[] {
  if (Array.isArray(incomingFromLanes) && incomingFromLanes.length > 0)
    return incomingFromLanes;
  return Number.isFinite(incomingFromLane) ? [Number(incomingFromLane)] : [];
}

/**
 * 计算“上一行 -> 当前行”的上半段斜线在当前行真正可见到的最右侧 lane。
 * 当前行只会画到上下两行中心连线与边界的中点，因此不能把上一行完整列位直接算进当前行宽度。
 */
function resolveLogGraphIncomingVisibleMaxLane(fromLane: number, toLane: number): number {
  if (!Number.isFinite(fromLane) || !Number.isFinite(toLane))
    return Math.max(0, Number.isFinite(toLane) ? toLane : fromLane);
  if (fromLane === toLane) return toLane;
  return Math.max(toLane, resolveLogGraphBoundaryVisibleLane(fromLane, toLane));
}

/**
 * 计算“当前行 -> 下一行”的下半段斜线在当前行真正可见到的最右侧 lane。
 * 这里同样只看当前行中心到边界中点的这一半，避免把下一行完整目标列误算成本行占位。
 */
function resolveLogGraphOutgoingVisibleMaxLane(fromLane: number, toLane: number): number {
  if (!Number.isFinite(fromLane) || !Number.isFinite(toLane))
    return Math.max(0, Number.isFinite(fromLane) ? fromLane : toLane);
  if (fromLane === toLane) return fromLane;
  return Math.max(fromLane, resolveLogGraphBoundaryVisibleLane(fromLane, toLane));
}

/**
 * 把“中心到中心”的跨行斜线换算成“行边界中点”时，对应的可见边界 lane。
 */
function resolveLogGraphBoundaryVisibleLane(fromLane: number, toLane: number): number {
  return Math.floor((fromLane + toLane) / 2);
}

/**
 * 把 lane 上界换算成图谱宽度，保持与 IDEA `PaintParameters` 相同的元素宽和文本间隔口径。
 */
export function resolveLogGraphWidth(maxLane: number, rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  const laneWidth = resolveLogGraphLaneWidth(rowHeight);
  const textGap = resolveLogGraphTextGap(rowHeight);
  const baseWidth = laneWidth * 2 + textGap;
  return Math.max(baseWidth, (Math.max(0, maxLane) + 1) * laneWidth + textGap);
}

/**
 * 按当前单元的可见图元求出最终 SVG 宽度，避免把历史全局最大 lane 带进每一行。
 */
export function resolveLogGraphCellWidth(cell?: GitGraphCell | null, rowHeight = LOG_GRAPH_RENDER_ROW_HEIGHT): number {
  return resolveLogGraphWidth(resolveLogGraphVisibleMaxLane(cell), rowHeight);
}
