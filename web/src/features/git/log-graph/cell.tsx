// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import {
  resolveLogGraphCellWidth,
  resolveLogGraphCircleRadius,
  resolveLogGraphHalfEdgeBoundaryY,
  resolveLogGraphHeadOuterCircleRadius,
  resolveLogGraphHeadRadiusDelta,
  resolveLogGraphHeadSelectedOuterCircleRadius,
  resolveLogGraphLaneCenter,
  resolveLogGraphLineWidth,
  resolveLogGraphRowCenter,
  resolveLogGraphSelectedCircleRadius,
  resolveLogGraphSelectedLineWidth,
  resolveLogGraphTerminalGap,
} from "./metrics";
import type { GitGraphCell, GitGraphEdge, GitGraphIncomingEdge } from "./model";

type GitLogGraphCellProps = {
  cell?: GitGraphCell;
  selected: boolean;
  rowHeight: number;
};

const LOG_GRAPH_TRACK_OPACITY = 1;
const LOG_GRAPH_ACTIVE_OPACITY = 1;
const LOG_GRAPH_ARROW_ANGLE_COS2 = 0.7;
const LOG_GRAPH_ARROW_LENGTH_FACTOR = 0.3;
const LOG_GRAPH_HALF_EDGE_CLIP_HORIZONTAL_OVERSCAN = 10000;

/**
 * 渲染单行 Git 图谱；由于 Web 端按“每行一个 SVG”分片绘制，这里把跨行斜线拆成上下半段，避免被相邻行背景覆盖后出现断线。
 */
export function GitLogGraphCell(props: GitLogGraphCellProps): JSX.Element {
  const cell = props.cell || {
    lane: 0,
    color: "transparent",
    tracks: [],
    edges: [],
    incomingFromLane: null,
    incomingFromLanes: [],
    incomingEdges: [],
    nodeKind: "default" as const,
    maxLane: 0,
  };
  const elementScopeKey = resolveGraphElementScopeKey(cell, React.useId());
  const width = resolveLogGraphCellWidth(cell, props.rowHeight);
  const height = props.rowHeight;
  const centerY = resolveLogGraphRowCenter(height);
  const radius = resolveLogGraphCircleRadius(height);
  const laneX = (lane: number): number => resolveLogGraphLaneCenter(lane, height);

  return (
    <svg
      width={width}
      height={height}
      className="shrink-0 overflow-visible"
      style={{ overflow: "visible" }}
      shapeRendering="geometricPrecision"
    >
      {cell.tracks.map((track) => renderGraphTrack({
        track,
        elementKey: `${elementScopeKey}:track:${track.hash || ""}:${track.sourceHash || ""}:${track.sourceRow ?? -1}:${track.lane}`,
        laneX,
        centerY,
        rowHeight: height,
      }))}
      {resolveGraphIncomingSegments(cell.incomingEdges, cell.incomingFromLane, cell.incomingFromLanes, cell.color, "solid").map((incoming, index) => renderGraphIncomingEdge({
        fromLane: incoming.fromLane,
        toLane: cell.lane,
        color: incoming.color,
        style: incoming.style,
        terminal: incoming.terminal,
        arrow: incoming.arrow,
        elementKey: `${elementScopeKey}:top:${incoming.fromLane}:${incoming.sourceHash || ""}:${index}`,
        laneX,
        centerY,
        rowHeight: height,
        selected: props.selected,
      }))}
      {cell.edges.map((edge, index) => renderGraphOutgoingEdge({
        edge,
        elementKey: `${elementScopeKey}:edge:${edge.sourceHash || cell.commitHash || ""}:${edge.targetHash || ""}:${edge.from}:${edge.to}:${index}`,
        laneX,
        centerY,
        rowHeight: height,
        selected: props.selected,
      }))}
      {renderGraphNode({
        x: laneX(cell.lane),
        y: centerY,
        radius,
        color: cell.color,
        kind: cell.nodeKind,
        selected: props.selected,
        rowHeight: height,
      })}
    </svg>
  );
}

/**
 * 为单个图谱单元生成实例级唯一前缀，避免真实列表中多行复用同名 clipPath id。
 */
function resolveGraphElementScopeKey(cell: GitGraphCell, scopeId: string): string {
  const commitHash = String(cell.commitHash || "").trim();
  return `cell:${commitHash || "anonymous"}:${String(scopeId || "")}`;
}

/**
 * 渲染不带节点的背景 track；若上一行通过斜线接入，则在本行补齐上半段对接，再继续向下延伸竖线。
 * 对齐 IDEA 后，track 还需要支持上/下两个方向各自独立的 terminal arrow。
 */
function renderGraphTrack(args: {
  track: GitGraphCell["tracks"][number];
  elementKey: string;
  laneX: (lane: number) => number;
  centerY: number;
  rowHeight: number;
}): JSX.Element {
  return (
    <React.Fragment key={args.elementKey}>
      {resolveGraphIncomingSegments(
        args.track.incomingEdges,
        args.track.incomingFromLane,
        args.track.incomingFromLanes,
        args.track.color,
        args.track.style,
        args.track.incomingTerminal,
        args.track.incomingArrow,
      ).map((incoming, index) => renderGraphIncomingEdge({
        fromLane: incoming.fromLane,
        toLane: args.track.lane,
        color: incoming.color,
        style: incoming.style,
        terminal: incoming.terminal,
        arrow: incoming.arrow,
        elementKey: `${args.elementKey}:incoming:${incoming.fromLane}:${incoming.sourceHash || ""}:${index}`,
        laneX: args.laneX,
        centerY: args.centerY,
        rowHeight: args.rowHeight,
        selected: false,
        muted: true,
      }))}
      {renderGraphOutgoingEdge({
        edge: {
          from: args.track.lane,
          to: args.track.outgoingToLane ?? args.track.lane,
          color: args.track.color,
          style: args.track.style,
          terminal: args.track.outgoingTerminal,
          arrow: args.track.outgoingArrow,
        },
        elementKey: `${args.elementKey}:outgoing`,
        laneX: args.laneX,
        centerY: args.centerY,
        rowHeight: args.rowHeight,
        selected: false,
        muted: true,
      })}
    </React.Fragment>
  );
}

/**
 * 统一归一化节点与背景 track 的入射 lane，兼容旧的单值字段与新的多值字段，避免共享祖先只保留最后一条入射线。
 */
function resolveGraphIncomingLanes(incomingFromLane: number | null | undefined, incomingFromLanes?: number[]): number[] {
  const source = Array.isArray(incomingFromLanes) && incomingFromLanes.length > 0
    ? incomingFromLanes
    : (incomingFromLane != null ? [incomingFromLane] : []);
  const normalized: number[] = [];
  for (const lane of source) {
    if (!Number.isFinite(lane) || normalized.includes(lane)) continue;
    normalized.push(lane);
  }
  return normalized;
}

/**
 * 把模型层的逐条入射信息归一化成渲染所需的半段集合。
 * 若模型尚未提供精确入射元数据，则回退到旧的 `incomingFromLane(s)` 语义，保证兼容现有数据。
 */
function resolveGraphIncomingSegments(
  incomingEdges: GitGraphIncomingEdge[] | undefined,
  incomingFromLane: number | null | undefined,
  incomingFromLanes: number[] | undefined,
  fallbackColor: string,
  fallbackStyle: "solid" | "dashed",
  terminal?: boolean,
  arrow?: boolean,
): GitGraphIncomingEdge[] {
  if (Array.isArray(incomingEdges) && incomingEdges.length > 0) {
    return incomingEdges.filter((edge) => Number.isFinite(edge.fromLane));
  }
  return resolveGraphIncomingLanes(incomingFromLane, incomingFromLanes).map((fromLane) => ({
    fromLane,
    color: fallbackColor,
    style: fallbackStyle,
    terminal,
    arrow,
  }));
}

/**
 * 计算斜线在当前行边界处的中点横坐标。
 * 终止箭头仍锚在边界中点，以对齐 IDEA 对非垂直线段的箭头落点语义。
 */
function resolveGraphBoundaryX(fromX: number, toX: number): number {
  return (fromX + toX) / 2;
}

/**
 * 渲染从上一行进入当前行中心的入射连线。
 * - 垂直线仍按 Web 分片绘制到当前行上边界，避免与相邻行背景互相覆盖；
 * - 斜线改为按 IDEA 的完整几何（上一行中心 -> 当前行中心）绘制，再裁切出当前行可见部分，
 *   这样不会在行接缝处叠出两个圆角端帽，避免截图里的折痕。
 */
function renderGraphIncomingEdge(args: {
  fromLane: number;
  toLane: number;
  color: string;
  style: "solid" | "dashed";
  elementKey: string;
  laneX: (lane: number) => number;
  centerY: number;
  rowHeight: number;
  selected: boolean;
  terminal?: boolean;
  arrow?: boolean;
  muted?: boolean;
}): JSX.Element {
  const targetX = args.laneX(args.toLane);
  const isTerminal = args.terminal === true;
  const isVertical = args.fromLane === args.toLane;
  const sourceX = isTerminal || isVertical ? targetX : args.laneX(args.fromLane);
  const usesClippedDiagonal = !isTerminal && !isVertical;
  const boundaryX = resolveGraphBoundaryX(sourceX, targetX);
  const y1 = usesClippedDiagonal
    ? args.centerY - args.rowHeight
    : (isTerminal
      ? resolveGraphTerminalBoundaryY(args.rowHeight, "up")
      : resolveLogGraphHalfEdgeBoundaryY(args.rowHeight, "up"));
  const x1 = usesClippedDiagonal ? sourceX : (isTerminal || isVertical ? targetX : boundaryX);
  const y2 = args.centerY;
  const x2 = targetX;
  const clipPathId = usesClippedDiagonal ? buildGraphClipPathId(args.elementKey) : undefined;
  const arrowTipX = usesClippedDiagonal ? boundaryX : x1;
  const arrowTipY = usesClippedDiagonal ? resolveLogGraphHalfEdgeBoundaryY(args.rowHeight, "up") : y1;
  return (
    <React.Fragment key={args.elementKey}>
      {clipPathId ? renderGraphHalfEdgeClipPath({
        clipPathId,
        rowHeight: args.rowHeight,
      }) : null}
      {args.selected ? renderGraphLine({
        x1,
        y1,
        x2,
        y2,
        color: "var(--cf-git-graph-ring)",
        style: args.style,
        rowHeight: args.rowHeight,
        selected: true,
        clipPathId,
      }) : null}
      {renderGraphLine({
        x1,
        y1,
        x2,
        y2,
        color: args.color,
        style: args.style,
        rowHeight: args.rowHeight,
        selected: false,
        muted: args.muted,
        clipPathId,
      })}
      {args.arrow && args.selected ? renderGraphArrow({
        fromX: x2,
        fromY: y2,
        tipX: arrowTipX,
        tipY: arrowTipY,
        color: "var(--cf-git-graph-ring)",
        selected: true,
        rowHeight: args.rowHeight,
      }) : null}
      {args.arrow ? renderGraphArrow({
        fromX: x2,
        fromY: y2,
        tipX: arrowTipX,
        tipY: arrowTipY,
        color: args.color,
        selected: false,
        rowHeight: args.rowHeight,
      }) : null}
    </React.Fragment>
  );
}

/**
 * 渲染从当前行中心发往下一行的出射连线。
 * - 垂直线仍只画到当前行下边界，保持 Web 分片渲染稳定；
 * - 斜线改为按 IDEA 的完整几何（当前行中心 -> 下一行中心）绘制，再裁切出当前行可见部分，
 *   保证跨行视觉上仍是一条直线，而不是两段各自带圆角端帽的半线。
 */
function renderGraphOutgoingEdge(args: {
  edge: GitGraphEdge;
  elementKey: string;
  laneX: (lane: number) => number;
  centerY: number;
  rowHeight: number;
  selected: boolean;
  muted?: boolean;
}): JSX.Element {
  const sourceX = args.laneX(args.edge.from);
  const y1 = args.centerY;
  const isTerminal = args.edge.terminal === true;
  const isVertical = args.edge.from === args.edge.to;
  const targetX = args.laneX(args.edge.to);
  const usesClippedDiagonal = !isTerminal && !isVertical;
  const boundaryX = resolveGraphBoundaryX(sourceX, targetX);
  const y2 = isTerminal
    ? resolveGraphTerminalBoundaryY(args.rowHeight, "down")
    : (usesClippedDiagonal
      ? args.centerY + args.rowHeight
      : resolveLogGraphHalfEdgeBoundaryY(args.rowHeight, "down"));
  const x1 = sourceX;
  const x2 = usesClippedDiagonal ? targetX : (isTerminal || isVertical ? targetX : boundaryX);
  const clipPathId = usesClippedDiagonal ? buildGraphClipPathId(args.elementKey) : undefined;
  const arrowTipX = usesClippedDiagonal ? boundaryX : x2;
  const arrowTipY = usesClippedDiagonal ? resolveLogGraphHalfEdgeBoundaryY(args.rowHeight, "down") : y2;
  return (
    <React.Fragment key={args.elementKey}>
      {clipPathId ? renderGraphHalfEdgeClipPath({
        clipPathId,
        rowHeight: args.rowHeight,
      }) : null}
      {args.selected ? renderGraphLine({
        x1,
        y1,
        x2,
        y2,
        color: "var(--cf-git-graph-ring)",
        style: args.edge.style,
        rowHeight: args.rowHeight,
        selected: true,
        clipPathId,
      }) : null}
      {renderGraphLine({
        x1,
        y1,
        x2,
        y2,
        color: args.edge.color,
        style: args.edge.style,
        rowHeight: args.rowHeight,
        selected: false,
        muted: args.muted,
        clipPathId,
      })}
      {args.edge.arrow && args.selected ? renderGraphArrow({
        fromX: x1,
        fromY: y1,
        tipX: arrowTipX,
        tipY: arrowTipY,
        color: "var(--cf-git-graph-ring)",
        selected: true,
        rowHeight: args.rowHeight,
      }) : null}
      {args.edge.arrow ? renderGraphArrow({
        fromX: x1,
        fromY: y1,
        tipX: arrowTipX,
        tipY: arrowTipY,
        color: args.edge.color,
        selected: false,
        rowHeight: args.rowHeight,
      }) : null}
    </React.Fragment>
  );
}

/**
 * 计算 terminal edge 在当前行内的收口位置。
 * 对齐 IDEA `SimpleGraphCellPainter` 的 `circleRadius / 2 + 1`，让箭头贴近边界但不压到节点圆心。
 */
function resolveGraphTerminalBoundaryY(rowHeight: number, direction: "up" | "down"): number {
  const gap = resolveLogGraphTerminalGap(rowHeight);
  return direction === "down" ? rowHeight - gap : gap;
}

/**
 * 为斜向半段生成当前行的裁切区域。
 * 这里保留与 `resolveLogGraphHalfEdgeBoundaryY` 一致的上下微重叠，让相邻行在分隔线区域仍有连续覆盖。
 */
function renderGraphHalfEdgeClipPath(args: {
  clipPathId: string;
  rowHeight: number;
}): JSX.Element {
  const overlap = resolveGraphHalfEdgeClipOverlap(args.rowHeight);
  const horizontalBounds = resolveGraphHalfEdgeClipHorizontalBounds();
  return (
    <defs>
      <clipPath id={args.clipPathId} clipPathUnits="userSpaceOnUse">
        <rect
          x={horizontalBounds.x}
          y={-overlap}
          width={horizontalBounds.width}
          height={args.rowHeight + overlap * 2}
        />
      </clipPath>
    </defs>
  );
}

/**
 * 生成稳定的 clipPath id，避免同一列表中多个 SVG 行互相冲突。
 */
function buildGraphClipPathId(key: string): string {
  return `cf-log-graph-clip-${String(key || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "edge"}`;
}

/**
 * 返回斜向半段裁切区域在上下需要额外覆盖的像素。
 * 这与 metrics 里的半段边界重叠语义保持一致，但局部保留在渲染层，避免为内部实现细节扩散额外导出。
 */
function resolveGraphHalfEdgeClipOverlap(rowHeight: number): number {
  return Math.max(1, Math.ceil(resolveLogGraphLineWidth(rowHeight)));
}

/**
 * 为半段斜线提供仅按纵向裁切的 clipPath 水平边界。
 * 当前行 SVG 会按“本行可见 lane”收窄宽度，但斜向入射/出射仍可能来自更外侧 lane；
 * 若继续使用 `width="100%"`，会把超出当前窄 SVG 视口的那一侧错误裁掉，导致真实拓扑被切歪。
 */
function resolveGraphHalfEdgeClipHorizontalBounds(): { x: number; width: number } {
  return {
    x: -LOG_GRAPH_HALF_EDGE_CLIP_HORIZONTAL_OVERSCAN,
    width: LOG_GRAPH_HALF_EDGE_CLIP_HORIZONTAL_OVERSCAN * 2,
  };
}

/**
 * 统一渲染实线/虚线段，供上半段入射、下半段出射与终止边复用。
 */
function renderGraphLine(args: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  style: "solid" | "dashed";
  rowHeight: number;
  selected: boolean;
  muted?: boolean;
  clipPathId?: string;
}): JSX.Element {
  const lineWidth = resolveLogGraphLineWidth(args.rowHeight);
  const selectedLineWidth = resolveLogGraphSelectedLineWidth(args.rowHeight);
  return (
    <line
      x1={args.x1}
      y1={args.y1}
      x2={args.x2}
      y2={args.y2}
      stroke={args.color}
      strokeWidth={args.selected ? selectedLineWidth : lineWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={args.style === "dashed" ? resolveGraphDashArray(args.x1, args.y1, args.x2, args.y2, args.rowHeight) : undefined}
      opacity={args.selected ? 1 : (args.muted ? LOG_GRAPH_TRACK_OPACITY : LOG_GRAPH_ACTIVE_OPACITY)}
      vectorEffect="non-scaling-stroke"
      clipPath={args.clipPathId ? `url(#${args.clipPathId})` : undefined}
    />
  );
}

/**
 * 渲染终止边箭头，用断续边尾部的小箭头表达分支到此为止。
 */
function renderGraphArrow(args: {
  fromX: number;
  fromY: number;
  tipX: number;
  tipY: number;
  color: string;
  selected: boolean;
  rowHeight: number;
}): JSX.Element {
  const [endArrowX1, endArrowY1] = rotateGraphPoint(
    args.fromX,
    args.fromY,
    args.tipX,
    args.tipY,
    Math.sqrt(LOG_GRAPH_ARROW_ANGLE_COS2),
    Math.sqrt(1 - LOG_GRAPH_ARROW_ANGLE_COS2),
    resolveGraphArrowLength(args.rowHeight),
  );
  const [endArrowX2, endArrowY2] = rotateGraphPoint(
    args.fromX,
    args.fromY,
    args.tipX,
    args.tipY,
    Math.sqrt(LOG_GRAPH_ARROW_ANGLE_COS2),
    -Math.sqrt(1 - LOG_GRAPH_ARROW_ANGLE_COS2),
    resolveGraphArrowLength(args.rowHeight),
  );
  const d = [
    `M ${formatGraphCoordinate(args.tipX)} ${formatGraphCoordinate(args.tipY)}`,
    `L ${formatGraphCoordinate(endArrowX1)} ${formatGraphCoordinate(endArrowY1)}`,
    `M ${formatGraphCoordinate(args.tipX)} ${formatGraphCoordinate(args.tipY)}`,
    `L ${formatGraphCoordinate(endArrowX2)} ${formatGraphCoordinate(endArrowY2)}`,
  ].join(" ");
  return (
    <path
      d={d}
      stroke={args.color}
      strokeWidth={args.selected ? resolveLogGraphSelectedLineWidth(args.rowHeight) : resolveLogGraphLineWidth(args.rowHeight)}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={1}
      vectorEffect="non-scaling-stroke"
    />
  );
}

/**
 * 按 IDEA `rotate(...)` 的几何把箭头两条边从终点反向旋出。
 */
function rotateGraphPoint(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  cos: number,
  sin: number,
  arrowLength: number,
): [number, number] {
  const translateX = x - centerX;
  const translateY = y - centerY;
  const distance = Math.hypot(translateX, translateY);
  if (distance <= 0.0001)
    return [centerX, centerY];
  const scaleX = arrowLength * translateX / distance;
  const scaleY = arrowLength * translateY / distance;
  const rotateX = scaleX * cos - scaleY * sin;
  const rotateY = scaleX * sin + scaleY * cos;
  return [rotateX + centerX, rotateY + centerY];
}

/**
 * 计算 terminal arrow 的臂长，对齐 IDEA `ARROW_LENGTH * rowHeight`。
 */
function resolveGraphArrowLength(rowHeight: number): number {
  return LOG_GRAPH_ARROW_LENGTH_FACTOR * rowHeight;
}

/**
 * 格式化 SVG 坐标，避免浮点尾数噪声干扰测试与 DOM 对比。
 */
function formatGraphCoordinate(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * 渲染普通节点与 HEAD 节点，整体语义对齐 IDEA `SimpleGraphCellPainter` / `HeadNodePainter`。
 * 默认节点直接填充圆；HEAD 节点未选中时绘制三层圆，选中时退化为单个放大的实心圆。
 */
function renderGraphNode(args: {
  x: number;
  y: number;
  radius: number;
  color: string;
  kind: "default" | "head";
  selected: boolean;
  rowHeight: number;
}): JSX.Element {
  if (args.kind === "head") {
    const delta = resolveLogGraphHeadRadiusDelta(args.rowHeight);
    const outerRadius = resolveLogGraphHeadOuterCircleRadius(args.rowHeight);
    const middleRadius = Math.max(0, outerRadius - delta);
    const innerRadius = Math.max(0, middleRadius - delta);
    if (args.selected) {
      return (
        <circle
          cx={args.x}
          cy={args.y}
          r={resolveLogGraphHeadSelectedOuterCircleRadius(args.rowHeight)}
          fill={args.color}
          stroke="none"
        />
      );
    }
    return (
      <g>
        <circle
          cx={args.x}
          cy={args.y}
          r={outerRadius}
          fill={args.color}
        />
        <circle
          cx={args.x}
          cy={args.y}
          r={middleRadius}
          fill="var(--cf-surface-solid)"
          stroke="none"
        />
        <circle
          cx={args.x}
          cy={args.y}
          r={innerRadius}
          fill={args.color}
          stroke="none"
        />
      </g>
    );
  }
  const nodeRadius = args.selected ? resolveLogGraphSelectedCircleRadius(args.rowHeight) : args.radius;
  return (
    <circle
      cx={args.x}
      cy={args.y}
      r={nodeRadius}
      fill={args.color}
      stroke="none"
    />
  );
}

/**
 * 按接近 IDEA painter 的规则推导虚线节距。
 * 由于 Web 端把跨行边拆成半段绘制，这里需要先还原对应的“逻辑整段长度”，避免 terminal edge 或半段斜线出现负 dash / 过密短线。
 */
function resolveGraphDashArray(x1: number, y1: number, x2: number, y2: number, rowHeight: number): string {
  const edgeLength = Math.hypot(x2 - x1, y2 - y1);
  const logicalEdgeLength = Math.abs(x1 - x2) < 0.001
    ? rowHeight
    : edgeLength * 2;
  const dashCount = Math.max(1, Math.floor(logicalEdgeLength / Math.max(1, rowHeight)));
  const spaceLength = rowHeight / 2 - 2;
  const dashLength = logicalEdgeLength / dashCount - spaceLength;
  return `${dashLength.toFixed(2)} ${spaceLength.toFixed(2)}`;
}
