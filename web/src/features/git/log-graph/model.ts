// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Git 日志图布局参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 React/TypeScript 架构重写。

import type { GitLogItem } from "../types";
import { resolveLogGraphVisibleMaxLane } from "./metrics";

export type GitGraphLineStyle = "solid" | "dashed";

export type GitGraphIncomingEdge = {
  fromLane: number;
  color: string;
  style: GitGraphLineStyle;
  targetHash?: string;
  sourceHash?: string;
  arrow?: boolean;
  terminal?: boolean;
};

export type GitGraphTrack = {
  lane: number;
  incomingFromLane: number;
  incomingFromLanes?: number[];
  incomingEdges?: GitGraphIncomingEdge[];
  outgoingToLane?: number;
  color: string;
  style: GitGraphLineStyle;
  hash?: string;
  sourceHash?: string;
  sourceRow?: number;
  targetRow?: number;
  sourceLane?: number;
  targetLane?: number;
  incomingTerminal?: boolean;
  incomingArrow?: boolean;
  outgoingTerminal?: boolean;
  outgoingArrow?: boolean;
};

export type GitGraphEdge = {
  from: number;
  to: number;
  color: string;
  style: GitGraphLineStyle;
  terminal?: boolean;
  arrow?: boolean;
  targetHash?: string;
  sourceHash?: string;
  sourceRow?: number;
  targetRow?: number;
  sourceLane?: number;
  targetLane?: number;
};

export type GitGraphCell = {
  lane: number;
  color: string;
  tracks: GitGraphTrack[];
  edges: GitGraphEdge[];
  incomingFromLane: number | null;
  incomingFromLanes?: number[];
  incomingEdges?: GitGraphIncomingEdge[];
  nodeKind: "default" | "head";
  maxLane: number;
  commitHash?: string;
};

type GitGraphActiveSource = {
  lane: number;
  sourceRow: number;
  hash: string;
  preserveLane?: boolean;
  headSeed?: string;
  headLane?: number | null;
  colorSeed?: string;
};

type ActiveGraphLane = {
  hash: string;
  stableLane: number;
  layoutIndex: number;
  colorSeed: string;
  headSeed: string;
  headLane: number | null;
  sources: GitGraphActiveSource[];
  targetRow: number;
};

type VisibleGraphLayout = {
  laneByHash: Map<string, number>;
  layoutIndexByHash: Map<string, number>;
  maxLane: number;
};

type GitGraphPositionMap = {
  nodePosition: number;
  trackPositionsByEdgeKey: Map<string, number>;
  trackPositionsByTargetHash: Map<string, number[]>;
  reservedEdgePositionsByTargetHash: Map<string, number[]>;
  positionsByLane: Map<number, number[]>;
};

type GitGraphPositionElement =
  | {
      kind: "node";
      lane: number;
      rowIndex: number;
    }
  | {
      kind: "track";
      lane: number;
      sourceLane: number;
      targetLane: number;
      sourceRow: number;
      targetRow: number;
      edgeKey: string;
      targetHash: string;
    }
  | {
      kind: "reserved-edge";
      lane: number;
      sourceLane: number;
      targetLane: number;
      sourceRow: number;
      targetRow: number;
      edgeKey: string;
      targetHash: string;
    };

type VisibleGraphTopology = {
  hashByRow: string[];
  visibleRows: number[];
  downRows: number[][];
  upRows: number[][];
};

type GitLogGraphHeadRefToken = {
  rank: number;
  name: string;
};

type GitLogGraphRawRefCandidate = GitLogGraphHeadRefToken & {
  rawName: string;
};

const LOG_GRAPH_REMOTE_NAME_HINTS = ["origin", "upstream"];
const LOG_GRAPH_LONG_EDGE_SIZE = 30;
const LOG_GRAPH_VISIBLE_PART_SIZE = 1;

export { LOG_GRAPH_BASE_WIDTH, LOG_GRAPH_LANE_WIDTH, LOG_GRAPH_TEXT_GAP, LOG_GRAPH_X_OFFSET } from "./metrics";

/**
 * 按接近 IDEA `DefaultColorGenerator` 的规则，把稳定颜色种子映射成图谱颜色。
 * - 颜色 ID 仍由上层 head-ref / fragment 语义提供；
 * - 实际 RGB/HSB 转换改成和 IDEA 同构，避免当前仓库固定调色盘与 IDEA 视觉方向明显偏离。
 */
export function resolveLogGraphColor(seed: string): string {
  const normalized = String(seed || "").trim() || "default";
  const colorId = resolveLogGraphColorId(normalized);
  if (colorId === 0) return "#000000";
  const r = rangeFix(colorId * 200 + 30);
  const g = rangeFix(colorId * 130 + 50);
  const b = rangeFix(colorId * 90 + 100);
  const { h } = rgbToHsb(r, g, b);
  return hsbToHex(h, 0.4, 0.65);
}

/**
 * 把颜色种子解析成接近 IDEA `GraphColorManagerImpl` 的 color id。
 * - head fragment 仍按 ref 名字做稳定哈希；
 * - 普通 fragment 则直接复用 `fragmentIndex` 整数，避免把 `fragment:${index}` 再二次哈希后偏离 IDEA 配色。
 */
function resolveLogGraphColorId(seed: string): number {
  const fragmentMatch = /^fragment:(-?\d+)$/.exec(seed);
  if (fragmentMatch)
    return Number(fragmentMatch[1] || 0);
  return hashLogGraphSeed(seed);
}

/**
 * 把任意整数拉回到接近 IDEA 的可用 RGB 区间，避免颜色过暗或过亮。
 */
function rangeFix(value: number): number {
  return Math.abs(value % 100) + 70;
}

/**
 * 把 RGB 转成 HSB，仅保留当前图谱颜色计算所需的色相信息。
 */
function rgbToHsb(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === red)
      h = ((green - blue) / delta) % 6;
    else if (max === green)
      h = (blue - red) / delta + 2;
    else
      h = (red - green) / delta + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

/**
 * 把 HSB 颜色转换成十六进制字符串，供前端 SVG 直接消费。
 */
function hsbToHex(h: number, s: number, v: number): string {
  const sector = Math.floor(h * 6);
  const fraction = h * 6 - sector;
  const p = v * (1 - s);
  const q = v * (1 - fraction * s);
  const t = v * (1 - (1 - fraction) * s);
  let red = 0;
  let green = 0;
  let blue = 0;
  switch (sector % 6) {
    case 0:
      red = v;
      green = t;
      blue = p;
      break;
    case 1:
      red = q;
      green = v;
      blue = p;
      break;
    case 2:
      red = p;
      green = v;
      blue = t;
      break;
    case 3:
      red = p;
      green = q;
      blue = v;
      break;
    case 4:
      red = t;
      green = p;
      blue = v;
      break;
    default:
      red = v;
      green = p;
      blue = q;
      break;
  }
  const toHex = (value: number): string => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

/**
 * 对齐 IDEA visible graph 语义构建图谱单元。
 * - `items` 是最终显示在列表里的可见提交；
 * - `graphItems` 是构建图谱时可用的完整行序列，允许保留被文本筛掉的隐藏提交，从而压缩出更接近 IDEA 的长边与 lane 延续。
 */
export function buildLogGraphCells(items: GitLogItem[], graphItems?: GitLogItem[]): GitGraphCell[] {
  const visibleItems = Array.isArray(items) ? items : [];
  const graphRows = normalizeLogGraphRows(visibleItems, graphItems);
  const layout = buildVisibleGraphLayout(graphRows);
  const active: Array<ActiveGraphLane | null> = [];
  const supplemental = new Map<string, ActiveGraphLane>();
  const rowByHash = new Map<string, number>();
  const itemByHash = new Map<string, GitLogItem>();
  const futureGraphHashes = new Set(layout.laneByHash.keys());
  const visibleHashes = new Set(visibleItems.map((item) => String(item.hash || "").trim()).filter(Boolean));
  const cellByHash = new Map<string, GitGraphCell>();

  for (let rowIndex = 0; rowIndex < graphRows.length; rowIndex += 1) {
    const item = graphRows[rowIndex]!;
    const hash = String(item.hash || "").trim();
    if (!hash) continue;
    rowByHash.set(hash, rowIndex);
    itemByHash.set(hash, item);
  }

  for (let rowIndex = 0; rowIndex < graphRows.length; rowIndex += 1) {
    const item = graphRows[rowIndex]!;
    const hash = String(item.hash || "").trim();
    if (!hash) continue;
    const isVisible = visibleHashes.has(hash);
    futureGraphHashes.delete(hash);

    const lane = layout.laneByHash.get(hash) ?? 0;
    const currentLayoutIndex = layout.layoutIndexByHash.get(hash) ?? 0;
    const currentEntry = resolveLogGraphActiveEntry(
      active[lane]?.hash === hash ? active[lane] : null,
      supplemental.get(hash) || null,
      lane,
      hash,
    );
    const incomingFromLanes = currentEntry
      ? normalizeLogGraphIncomingLanes(currentEntry.sources.map((source) => source.lane), lane)
      : [];
    const incomingFromLane = resolvePrimaryLogGraphIncomingLane(incomingFromLanes, lane);

    const inheritedSourceHead = resolveLogGraphDominantSourceHead(currentEntry?.sources || []);
    const inheritedHeadSeed = inheritedSourceHead.headSeed || currentEntry?.headSeed || "";
    const inheritedHeadLane = inheritedSourceHead.headSeed
      ? inheritedSourceHead.headLane
      : (currentEntry?.headLane ?? null);
    const directColorSeed = resolveLogGraphDirectColorSeed(item);
    const headSeed = inheritedHeadSeed || directColorSeed || "";
    const headLane = inheritedHeadSeed
      ? inheritedHeadLane
      : (directColorSeed ? currentLayoutIndex : inheritedHeadLane);
    const colorSeed = resolveLogGraphFragmentColorSeed(headSeed, headLane, currentLayoutIndex, currentEntry?.colorSeed || hash);
    const tracks = isVisible ? buildLogGraphTracks(active, supplemental, lane, hash, rowIndex) : [];
    const parents = Array.isArray(item.parents) ? item.parents.filter(Boolean) : [];
    const next = cloneLogGraphActiveLanes(active, !isVisible);
    const displacedEntry = next[lane];
    const displacedParentSources = new Map<string, GitGraphActiveSource[]>();
    if (displacedEntry && displacedEntry.hash !== hash) {
      const normalizedParents = new Set(parents.map((parent) => String(parent || "").trim()).filter(Boolean));
      if (normalizedParents.has(displacedEntry.hash)) {
        const carriedSources = displacedEntry.sources.filter((source) => {
          if (source.hash === hash) return false;
          const sourceItem = itemByHash.get(source.hash);
          const sourceDirectSeed = resolveLogGraphDirectColorSeed(sourceItem);
          const isSupplementalRemoteRefSource = !hasHeadDecoration(String(sourceItem?.decorations || ""))
            && LOG_GRAPH_REMOTE_NAME_HINTS.some((hint) => sourceDirectSeed.startsWith(`${hint}/`));
          return !isSupplementalRemoteRefSource;
        });
        if (carriedSources.length > 0)
          displacedParentSources.set(displacedEntry.hash, carriedSources);
      } else if (shouldPreserveDisplacedLogGraphEntry(displacedEntry, parents)) {
        supplemental.set(displacedEntry.hash, resolveLogGraphActiveEntry(
          supplemental.get(displacedEntry.hash) || null,
          displacedEntry,
          displacedEntry.stableLane,
          displacedEntry.hash,
        )!);
      }
    }
    next[lane] = null;
    supplemental.delete(hash);

    const edges: GitGraphEdge[] = [];
    if (parents.length <= 0) {
      if (isVisible) {
        edges.push({
          from: lane,
          to: lane,
          color: resolveLogGraphColor(colorSeed),
          style: "dashed",
          terminal: true,
          arrow: true,
          targetHash: "",
          sourceHash: hash,
          sourceRow: rowIndex,
          sourceLane: lane,
          targetLane: lane,
        });
      }
    } else {
      for (let index = 0; index < parents.length; index += 1) {
        const parent = String(parents[index] || "").trim();
        if (!parent) continue;
        const parentLane = layout.laneByHash.get(parent);
        const existingParentLane = findLogGraphLaneByHash(next, parent);
        const existingParentEntry = resolveLogGraphActiveEntry(
          existingParentLane >= 0 ? next[existingParentLane] : null,
          supplemental.get(parent) || null,
          parentLane ?? lane,
          parent,
        );
        const existingParentSeed = existingParentEntry?.colorSeed || "";
        const parentItem = itemByHash.get(parent);
        const inheritedParentHeadSeed = existingParentEntry?.headSeed || "";
        const inheritedParentHeadLane = existingParentEntry?.headLane ?? null;
        const parentDirectSeed = resolveLogGraphDirectColorSeed(parentItem);
        const inheritedParentFallbackHeadSeed = headSeed;
        const inheritedParentFallbackHeadLane = headLane;
        const parentHeadSeed = inheritedParentHeadSeed || inheritedParentFallbackHeadSeed || parentDirectSeed;
        const parentHeadLane = inheritedParentHeadSeed
          ? inheritedParentHeadLane
          : (inheritedParentFallbackHeadSeed
              ? inheritedParentFallbackHeadLane
              : (parentDirectSeed ? parentLane ?? null : null));
        const parentSeed = resolveLogGraphFragmentColorSeed(
          parentHeadSeed,
          parentHeadLane,
          parentLane ?? lane,
          existingParentSeed || (index === 0 ? colorSeed : `parent:${parent}`),
        );
        const parentLayoutIndex = layout.layoutIndexByHash.get(parent) ?? 0;
        const edgeColorSeed = currentLayoutIndex >= parentLayoutIndex ? colorSeed : parentSeed;
        const parentSources = [
          ...(displacedParentSources.get(parent) || []),
          ...resolveLogGraphParentSources(
            currentEntry,
            lane,
            rowIndex,
            isVisible,
            hash,
            parentHeadSeed,
            parentHeadLane,
            edgeColorSeed,
          ),
        ];
        const parentAppearsLater = futureGraphHashes.has(parent);
        const targetRow = rowByHash.get(parent);
        if (!parentAppearsLater || parentLane == null || targetRow == null) {
          if (isVisible) {
            edges.push({
              from: lane,
              to: lane,
              color: resolveLogGraphColor(edgeColorSeed),
              style: "dashed",
              terminal: true,
              arrow: true,
              targetHash: parent,
              sourceHash: hash,
              sourceRow: rowIndex,
              sourceLane: lane,
              targetLane: lane,
            });
          }
          continue;
        }

        const resolvedParentSeed = index === 0
          ? parentSeed
          : (existingParentEntry?.colorSeed || parentSeed);
        placeLogGraphCommit(
          next,
          supplemental,
          parent,
          parentLane,
          parentLayoutIndex,
          resolvedParentSeed,
          parentHeadSeed,
          parentHeadLane,
          parentSources,
          targetRow,
        );
        if (isVisible) {
            edges.push({
              from: lane,
              to: parentLane,
              color: resolveLogGraphColor(edgeColorSeed),
              style: "solid",
              targetHash: parent,
              sourceHash: hash,
              sourceRow: rowIndex,
              targetRow,
              sourceLane: lane,
              targetLane: parentLane,
            });
        }
      }
    }

    trimTrailingLogGraphLanes(next);
    if (isVisible) {
      cellByHash.set(hash, {
        lane,
        color: resolveLogGraphColor(colorSeed),
        tracks,
        edges,
        incomingFromLane,
        incomingFromLanes,
        nodeKind: hasHeadDecoration(item.decorations) ? "head" : "default",
        maxLane: computeLogGraphMaxLane(lane, tracks, edges),
        commitHash: hash,
      });
    }

    active.length = 0;
    active.push(...next);
  }

  const compressed = compressLogGraphCells(
    visibleItems.map((item) => cellByHash.get(String(item.hash || "").trim()) || createEmptyLogGraphCell()),
  );
  realignLogGraphSingleIncomingEdgeColors(compressed, itemByHash);
  return compressed;
}

/**
 * 文件历史模式只保留单轨时间线，不复用完整仓库拓扑，避免路径历史把图谱列宽撑爆并挤压提交信息列。
 */
export function buildFileHistoryGraphCells(items: GitLogItem[]): GitGraphCell[] {
  return items.map((item, index) => {
    const hash = String(item.hash || "").trim();
    const fallbackSeed = hash || `file-history:${index}`;
    const colorSeed = resolveLogGraphColorSeed(item, fallbackSeed);
    const color = resolveLogGraphColor(colorSeed);
    const parents = Array.isArray(item.parents) ? item.parents.filter(Boolean) : [];
    return {
      lane: 0,
      color,
      tracks: [],
      edges: [
        parents.length > 0
          ? {
              from: 0,
              to: 0,
              color,
              style: "solid",
              targetHash: parents[0] || "",
            }
          : {
              from: 0,
              to: 0,
              color,
              style: "dashed",
              terminal: true,
              arrow: true,
              targetHash: "",
            },
      ],
      incomingFromLane: index > 0 ? 0 : null,
      incomingFromLanes: index > 0 ? [0] : [],
      nodeKind: hasHeadDecoration(item.decorations) ? "head" : "default",
      maxLane: 0,
      commitHash: hash,
    };
  });
}

/**
 * 为当前可见列表挑选图谱构建所需的输入行。
 * - 若后端已返回完整图谱上下文，则优先使用；
 * - 若上下文缺失可见提交，则回退到仅使用当前可见列表，避免图谱与列表脱节。
 */
function normalizeLogGraphRows(items: GitLogItem[], graphItems?: GitLogItem[]): GitLogItem[] {
  const candidates = Array.isArray(graphItems) && graphItems.length > 0 ? graphItems : items;
  const dedupedCandidates: GitLogItem[] = [];
  const candidateHashes = new Set<string>();
  for (const item of candidates) {
    const hash = String(item.hash || "").trim();
    if (!hash || candidateHashes.has(hash)) continue;
    candidateHashes.add(hash);
    dedupedCandidates.push(item);
  }
  const visibleHashes = new Set(items.map((item) => String(item.hash || "").trim()).filter(Boolean));
  for (const hash of visibleHashes) {
    if (!candidateHashes.has(hash)) return items;
  }
  return dedupedCandidates;
}

/**
 * 构造空图谱单元，作为上下文缺失时的安全兜底，避免列表与图谱数量错位。
 */
function createEmptyLogGraphCell(): GitGraphCell {
  return {
    lane: 0,
    color: resolveLogGraphColor("default"),
    tracks: [],
    edges: [],
    incomingFromLane: null,
    incomingFromLanes: [],
    incomingEdges: [],
    nodeKind: "default",
    maxLane: 0,
    commitHash: "",
  };
}

/**
 * 把内部稳定 lane 压缩成当前行真正可见的局部位置。
 * - 保留稳定 lane 的相对顺序，用于参考上游 `GraphLayoutBuilder` 决定的左右关系；
 * - 去掉当前行并不存在的空槽，靠近 IDEA `PrintElementGenerator` 的按行位置分配语义；
 * - 上下半段连线的“另一行位置”分别映射到相邻可见行，避免继续使用全局 lane 导致宽度和斜线都被拉大。
 */
function compressLogGraphCells(cells: GitGraphCell[]): GitGraphCell[] {
  const positionMaps = cells.map((cell, index) => buildLogGraphPositionMap(cell, index));
  const compressed = cells.map((cell, index) => compressLogGraphCell(
    cell,
    cells[index - 1],
    positionMaps[index - 1],
    positionMaps[index],
    cells[index + 1],
    positionMaps[index + 1],
  ));
  return realignCompressedLogGraphNeighborGeometry(compressed);
}

/**
 * 为单个可见行建立“图元 -> 当前行局部位置”的映射。
 * - 对齐 IDEA `PrintElementGeneratorImpl + GraphElementComparatorByLayoutIndex`，位置顺序按 node/edge 图元排序决定，而不是简单按唯一 lane 去重；
 * - 这样同一行里“节点 + 经过的边”即使共享稳定 lane，也仍能分配到不同的局部位置，避免被提前压成一列。
 */
function buildLogGraphPositionMap(cell: GitGraphCell, rowIndex: number): GitGraphPositionMap {
  const elements = createLogGraphPositionElements(cell, rowIndex).sort((left, right) => compareLogGraphPositionElements(left, right));
  const trackPositionsByEdgeKey = new Map<string, number>();
  const trackPositionsByTargetHash = new Map<string, number[]>();
  const reservedEdgePositionsByTargetHash = new Map<string, number[]>();
  const positionsByLane = new Map<number, number[]>();
  let nodePosition = 0;
  elements.forEach((element, position) => {
    if (element.kind === "node") {
      const positionsForLane = positionsByLane.get(element.lane) || [];
      positionsForLane.push(position);
      positionsByLane.set(element.lane, positionsForLane);
      nodePosition = position;
      return;
    }
    if (element.kind === "reserved-edge") {
      const positions = reservedEdgePositionsByTargetHash.get(element.targetHash) || [];
      positions.push(position);
      reservedEdgePositionsByTargetHash.set(element.targetHash, positions);
      return;
    }
    const positionsForLane = positionsByLane.get(element.lane) || [];
    positionsForLane.push(position);
    positionsByLane.set(element.lane, positionsForLane);
    if (!trackPositionsByEdgeKey.has(element.edgeKey))
      trackPositionsByEdgeKey.set(element.edgeKey, position);
    const positions = trackPositionsByTargetHash.get(element.targetHash) || [];
    positions.push(position);
    trackPositionsByTargetHash.set(element.targetHash, positions);
  });
  return {
    nodePosition,
    trackPositionsByEdgeKey,
    trackPositionsByTargetHash,
    reservedEdgePositionsByTargetHash,
    positionsByLane,
  };
}

/**
 * 把当前节点与所有过路线投影成一组可排序图元。
 * 对齐 IDEA `PrintElementGeneratorImpl#getSortedVisibleElementsInRow`：
 * - 当前行包含节点本身；
 * - 包含从当前行向下穿过本行的 normal edge / track；
 * - 不包含“从上一行结束在当前节点”的 normal incoming edge；
 * - IDEA 的相邻 normal direct edge 不会作为独立 `GraphEdge` 留在 `visible elements` 里；
 *   因此这里只在当前行几乎没有别的可见图元时，补一个最小 `reserved-edge` 占位，
 *   用来保住下一行目标列，避免过滤隐藏提交后把弯折错误提前到上一行。
 */
function createLogGraphPositionElements(cell: GitGraphCell, rowIndex: number): GitGraphPositionElement[] {
  const elements: GitGraphPositionElement[] = [
    {
      kind: "node",
      lane: cell.lane,
      rowIndex,
    },
  ];
  const hasVisibleTrackElements = (cell.tracks || []).length > 0;
  for (const track of cell.tracks) {
    elements.push(createLogGraphTrackPositionElement(track, rowIndex));
  }
  for (const edge of cell.edges) {
    const reservedEdgeElement = createLogGraphReservedEdgePositionElement(
      edge,
      rowIndex,
      hasVisibleTrackElements,
    );
    if (!reservedEdgeElement) continue;
    elements.push(reservedEdgeElement);
  }
  return elements;
}

/**
 * 把背景 track 转成可参与排序的位置图元。
 */
function createLogGraphTrackPositionElement(
  track: GitGraphTrack,
  rowIndex: number,
): Extract<GitGraphPositionElement, { kind: "track" }> {
  return {
    kind: "track",
    lane: track.lane,
    sourceLane: Number(track.sourceLane ?? track.incomingFromLane ?? track.lane),
    targetLane: Number(track.targetLane ?? track.lane),
    sourceRow: Number(track.sourceRow ?? rowIndex - 1),
    targetRow: Number(track.targetRow ?? rowIndex + 1),
    edgeKey: buildLogGraphTrackEdgeKey(String(track.hash || ""), String(track.sourceHash || "")),
    targetHash: String(track.hash || ""),
  };
}

/**
 * 把当前节点发出的非垂直边转成“仅占位”的排序图元。
 * 该图元不是 IDEA 原始 `visible elements` 的一部分，只在当前行缺少可见图元时作为压缩补偿使用，
 * 不参与相邻可见行的精确对接，避免把相邻 direct edge 错当成一条独立泳道。
 */
function createLogGraphReservedEdgePositionElement(
  edge: GitGraphEdge,
  rowIndex: number,
  hasVisibleTrackElements: boolean,
): Extract<GitGraphPositionElement, { kind: "reserved-edge" }> | null {
  const sourceLane = Number(edge.sourceLane ?? edge.from);
  const targetLane = Number(edge.targetLane ?? edge.to);
  const targetRow = Number(edge.targetRow);
  const sourceHash = String(edge.sourceHash || "");
  const targetHash = String(edge.targetHash || "");
  if (edge.terminal || !sourceHash || !targetHash) return null;
  if (hasVisibleTrackElements) return null;
  if (!Number.isFinite(sourceLane) || !Number.isFinite(targetLane) || !Number.isFinite(targetRow)) return null;
  if (sourceLane === targetLane) return null;
  return {
    kind: "reserved-edge",
    lane: Math.max(sourceLane, targetLane),
    sourceLane,
    targetLane,
    sourceRow: Number(edge.sourceRow ?? rowIndex),
    targetRow,
    edgeKey: buildLogGraphTrackEdgeKey(targetHash, sourceHash),
    targetHash,
  };
}

/**
 * 按 IDEA `GraphElementComparatorByLayoutIndex` 的思路比较当前行两个图元的先后位置。
 */
function compareLogGraphPositionElements(left: GitGraphPositionElement, right: GitGraphPositionElement): number {
  if (left.kind !== "node" && right.kind !== "node")
    return compareLogGraphTrackElements(left, right);
  if (left.kind !== "node" && right.kind === "node")
    return compareLogGraphTrackWithNode(left, right);
  if (left.kind === "node" && right.kind !== "node")
    return -compareLogGraphTrackWithNode(right, left);
  return 0;
}

/**
 * 比较一条过路线与一个节点的左右先后。
 * 规则直接对齐 IDEA `compare2(edge, node)`：
 * 先看 edge 两端更靠右的 layout index；若相同，再用 edge 的 sourceRow 与节点行号断平。
 */
function compareLogGraphTrackWithNode(
  track: Extract<GitGraphPositionElement, { kind: "track" | "reserved-edge" }>,
  node: Extract<GitGraphPositionElement, { kind: "node" }>,
): number {
  const edgeLane = Math.max(track.sourceLane, track.targetLane);
  if (edgeLane !== node.lane) return edgeLane - node.lane;
  return track.sourceRow - node.rowIndex;
}

/**
 * 比较两条过路线的左右先后。
 * 规则对应 IDEA `GraphElementComparatorByLayoutIndex.compare(edge1, edge2)` 的 normal edge 分支。
 */
function compareLogGraphTrackElements(
  left: Extract<GitGraphPositionElement, { kind: "track" | "reserved-edge" }>,
  right: Extract<GitGraphPositionElement, { kind: "track" | "reserved-edge" }>,
): number {
  if (left.sourceRow === right.sourceRow) {
    if (left.targetRow < right.targetRow) {
      return -compareLogGraphTrackWithNode(right, {
        kind: "node",
        lane: left.targetLane,
        rowIndex: left.targetRow,
      });
    }
    return compareLogGraphTrackWithNode(left, {
      kind: "node",
      lane: right.targetLane,
      rowIndex: right.targetRow,
    });
  }
  if (left.sourceRow < right.sourceRow) {
    return compareLogGraphTrackWithNode(left, {
      kind: "node",
      lane: right.sourceLane,
      rowIndex: right.sourceRow,
    });
  }
  return -compareLogGraphTrackWithNode(right, {
    kind: "node",
    lane: left.sourceLane,
    rowIndex: left.sourceRow,
  });
}

/**
 * 为一条可见 edge 生成稳定 key，供相邻可见行之间精确对接同一条边。
 */
function buildLogGraphTrackEdgeKey(targetHash: string, sourceHash: string): string {
  return `${sourceHash}\u0000${targetHash}`;
}

/**
 * 按当前行、上一行和下一行的位置映射，把单元从稳定 lane 坐标转换成渲染层可直接消费的局部位置坐标。
 */
function compressLogGraphCell(
  cell: GitGraphCell,
  previousCell: GitGraphCell | undefined,
  previousMap: GitGraphPositionMap | undefined,
  currentMap: GitGraphPositionMap | undefined,
  nextCell: GitGraphCell | undefined,
  nextMap: GitGraphPositionMap | undefined,
): GitGraphCell {
  const incomingFromLanes = resolveCompressedLogGraphNodeIncomingLanes(
    String(cell.commitHash || "").trim(),
    cell.incomingFromLanes || [],
    previousCell,
    previousMap,
    currentMap?.nodePosition ?? 0,
  );
  const lane = resolveCompressedLogGraphNodeLane(
    String(cell.commitHash || "").trim(),
    previousMap,
    currentMap?.nodePosition ?? 0,
    incomingFromLanes,
  );
  const occupiedTrackLanes = new Set<number>([lane]);
  const orderedTracks = [...cell.tracks].sort((left, right) =>
    compareCompressedLogGraphTrackProcessingOrder(left, right, currentMap),
  );
  const compressedTrackByKey = new Map<string, GitGraphTrack>();
  for (const track of orderedTracks) {
    const mappedLane = currentMap?.trackPositionsByEdgeKey.get(
      buildLogGraphTrackEdgeKey(String(track.hash || ""), String(track.sourceHash || "")),
    ) ?? lane;
    const currentLane = resolveCompressedLogGraphTrackCurrentLane(
      track,
      mappedLane,
      currentMap?.nodePosition ?? lane,
      previousCell,
      previousMap,
      nextCell,
      occupiedTrackLanes,
    );
    occupiedTrackLanes.add(currentLane);
    const mappedIncomingFromLanes = resolveCompressedLogGraphTrackIncomingLanes(
      track,
      cell,
      previousCell,
      previousMap,
      currentLane,
    );
    compressedTrackByKey.set(buildLogGraphTrackEdgeKey(String(track.hash || ""), String(track.sourceHash || "")), {
      ...track,
      lane: currentLane,
      incomingFromLane: resolvePrimaryLogGraphIncomingLane(mappedIncomingFromLanes, currentLane) ?? currentLane,
      incomingFromLanes: mappedIncomingFromLanes,
      outgoingToLane: resolveCompressedLogGraphTrackOutgoingLane(track, nextCell, nextMap, currentLane),
    });
  }
  const tracks = cell.tracks.map((track) =>
    compressedTrackByKey.get(buildLogGraphTrackEdgeKey(String(track.hash || ""), String(track.sourceHash || ""))) || track,
  );
  // 若当前节点本身带 terminal arrow，而右侧仍有连续 track，则节点/箭头应落在最右侧连续列上。
  const terminalNodeLane = cell.edges.some((edge) => edge.terminal)
    ? tracks.reduce((maxLane, track) => Math.max(maxLane, track.lane), lane)
    : lane;
  const edges = cell.edges.map((edge) => {
    const from = terminalNodeLane;
    const to = resolveCompressedLogGraphEdgeTo(edge, String(cell.commitHash || "").trim(), nextCell, nextMap, from);
    return {
      ...edge,
      from,
      to,
    };
  });
  return {
    ...cell,
    lane: terminalNodeLane,
    tracks,
    edges,
    incomingFromLane: resolvePrimaryLogGraphIncomingLane(incomingFromLanes, terminalNodeLane),
    incomingFromLanes,
    maxLane: computeLogGraphMaxLane(terminalNodeLane, tracks, edges),
  };
}

/**
 * 在所有行完成压缩后，再按“相邻压缩行”的真实列位做一次终点对齐。
 * 这样同一条长边在当前行的下半段，会严格接到下一行已经压缩完成的 track/node 列位，
 * 避免出现“当前行按原始 positionMap 先折弯、下一行又被二次压缩改列”的错接与假 zig-zag。
 */
function realignCompressedLogGraphNeighborGeometry(cells: GitGraphCell[]): GitGraphCell[] {
  const aligned = cells.map((cell) => ({
    ...cell,
    incomingFromLanes: [...(cell.incomingFromLanes || [])],
    incomingEdges: [...(cell.incomingEdges || [])],
    tracks: (cell.tracks || []).map((track) => ({
      ...track,
      incomingFromLanes: [...(track.incomingFromLanes || [])],
      incomingEdges: [...(track.incomingEdges || [])],
    })),
    edges: (cell.edges || []).map((edge) => ({ ...edge })),
  }));
  stabilizeCompressedLogGraphSiblingTrackOrder(aligned);
  synchronizeCompressedLogGraphNeighborGeometry(aligned);
  advanceCompressedLogGraphLongTrackCorners(aligned);
  synchronizeCompressedLogGraphNeighborGeometry(aligned);

  return aligned.map((cell) => {
    const incomingFromLanes = resolveLogGraphIncomingLanesFromEdges(
      cell.incomingEdges,
      cell.incomingFromLanes,
      cell.incomingFromLane,
    );
    return {
      ...cell,
      incomingFromLane: resolvePrimaryLogGraphIncomingLane(incomingFromLanes, cell.lane),
      incomingFromLanes,
      maxLane: computeLogGraphMaxLane(cell.lane, cell.tracks || [], cell.edges || []),
    };
  });
}

/**
 * 当节点没有直接 decoration，且只有一条真实入射逻辑 edge 时，
 * 该入射 edge 在所有可见段上的颜色都应与目标节点 fragment 一致。
 * 这样可以避免“节点已经切到目标 fragment 颜色，但入射线仍保留旧 fragment 颜色”的整段错色。
 */
function realignLogGraphSingleIncomingEdgeColors(
  cells: GitGraphCell[],
  itemByHash: ReadonlyMap<string, GitLogItem>,
): void {
  for (const cell of cells) {
    const commitHash = String(cell.commitHash || "").trim();
    if (!commitHash) continue;
    if (resolveLogGraphDirectColorSeed(itemByHash.get(commitHash))) continue;
    const incomingByEdgeKey = new Map<string, GitGraphIncomingEdge>();
    for (const incomingEdge of cell.incomingEdges || []) {
      const sourceHash = String(incomingEdge.sourceHash || "").trim();
      const targetHash = String(incomingEdge.targetHash || "").trim();
      if (!sourceHash || !targetHash) continue;
      const edgeKey = buildLogGraphTrackEdgeKey(targetHash, sourceHash);
      if (!incomingByEdgeKey.has(edgeKey))
        incomingByEdgeKey.set(edgeKey, incomingEdge);
    }
    if (incomingByEdgeKey.size !== 1) continue;
    const incomingEdge = [...incomingByEdgeKey.values()][0]!;
    const targetColor = String(cell.color || "").trim();
    if (!targetColor || incomingEdge.color === targetColor) continue;
    const sourceHash = String(incomingEdge.sourceHash || "").trim();
    const targetHash = String(incomingEdge.targetHash || "").trim();
    if (!sourceHash || !targetHash) continue;
    for (const candidateCell of cells) {
      for (const edge of candidateCell.edges || []) {
        if (String(edge.sourceHash || "").trim() !== sourceHash) continue;
        if (String(edge.targetHash || "").trim() !== targetHash) continue;
        edge.color = targetColor;
      }
      for (const track of candidateCell.tracks || []) {
        if (String(track.sourceHash || "").trim() !== sourceHash) continue;
        if (String(track.hash || "").trim() !== targetHash) continue;
        track.color = targetColor;
        for (const nestedIncomingEdge of track.incomingEdges || []) {
          if (String(nestedIncomingEdge.sourceHash || "").trim() !== sourceHash) continue;
          if (String(nestedIncomingEdge.targetHash || "").trim() !== targetHash) continue;
          nestedIncomingEdge.color = targetColor;
        }
      }
      for (const candidateIncomingEdge of candidateCell.incomingEdges || []) {
        if (String(candidateIncomingEdge.sourceHash || "").trim() !== sourceHash) continue;
        if (String(candidateIncomingEdge.targetHash || "").trim() !== targetHash) continue;
        candidateIncomingEdge.color = targetColor;
      }
    }
  }
}

/**
 * 按最终相邻可见行重新同步上下对接几何。
 * 每次同步前都会清空上一轮累积的 incoming edge，避免多轮收敛时重复追加，
 * 这样在“先对齐一次、再提前折角、再对齐一次”的流程里，最终几何仍然是单一真值。
 */
function synchronizeCompressedLogGraphNeighborGeometry(cells: GitGraphCell[]): void {
  resetCompressedLogGraphIncomingGeometry(cells);
  for (let index = 0; index < cells.length - 1; index += 1) {
    const currentCell = cells[index]!;
    const nextCell = cells[index + 1]!;
    const nextTrackByKey = new Map<string, GitGraphTrack>();
    for (const nextTrack of nextCell.tracks || []) {
      const key = buildLogGraphTrackEdgeKey(String(nextTrack.hash || ""), String(nextTrack.sourceHash || ""));
      if (!key || nextTrackByKey.has(key)) continue;
      nextTrackByKey.set(key, nextTrack);
    }

    for (const edge of currentCell.edges || []) {
      if (edge.terminal) continue;
      const targetHash = String(edge.targetHash || "").trim();
      const sourceHash = String(edge.sourceHash || currentCell.commitHash || "").trim();
      if (!targetHash) continue;
      const nextTrack = nextTrackByKey.get(buildLogGraphTrackEdgeKey(targetHash, sourceHash));
      if (nextTrack) {
        edge.to = nextTrack.lane;
        nextTrack.incomingEdges = appendLogGraphIncomingEdges(nextTrack.incomingEdges, {
          fromLane: edge.from,
          color: edge.color,
          style: edge.style,
          targetHash,
          sourceHash,
          arrow: edge.arrow,
          terminal: edge.terminal,
        });
        continue;
      }
      if (String(nextCell.commitHash || "").trim() === targetHash) {
        edge.to = nextCell.lane;
        nextCell.incomingEdges = appendLogGraphIncomingEdges(nextCell.incomingEdges, {
          fromLane: edge.from,
          color: edge.color,
          style: edge.style,
          targetHash,
          sourceHash,
          arrow: edge.arrow,
          terminal: edge.terminal,
        });
      }
    }

    for (const track of currentCell.tracks || []) {
      const targetHash = String(track.hash || "").trim();
      const sourceHash = String(track.sourceHash || "").trim();
      if (!targetHash || !sourceHash) continue;
      const nextTrack = nextTrackByKey.get(buildLogGraphTrackEdgeKey(targetHash, sourceHash));
      if (nextTrack) {
        track.outgoingToLane = nextTrack.lane;
        const incomingFromLanes = normalizeLogGraphIncomingLanes([track.lane], nextTrack.lane);
        nextTrack.incomingFromLanes = incomingFromLanes;
        nextTrack.incomingFromLane = resolvePrimaryLogGraphIncomingLane(incomingFromLanes, nextTrack.lane) ?? nextTrack.lane;
        nextTrack.incomingEdges = appendLogGraphIncomingEdges(nextTrack.incomingEdges, {
          fromLane: track.lane,
          color: track.color,
          style: track.style,
          targetHash,
          sourceHash,
          arrow: track.outgoingArrow,
          terminal: track.outgoingTerminal,
        });
        continue;
      }
      if (String(nextCell.commitHash || "").trim() !== targetHash) continue;
      /**
       * 对齐 IDEA `PrintElementGeneratorImpl#createEndPositionFunction`，
       * 当当前可见 track 的下一行就是目标节点时，本行下半段应直接对接目标节点列。
       * 即便这是长边靠近目标端的 terminal 可见段，也不能再额外保留一行竖线，
       * 否则会把 IDEA 里的单段斜线错误拖成“先直后斜”。
       */
      track.outgoingToLane = nextCell.lane;
      nextCell.incomingEdges = appendLogGraphIncomingEdges(nextCell.incomingEdges, {
        fromLane: track.lane,
        color: track.color,
        style: track.style,
        targetHash,
        sourceHash,
        arrow: track.outgoingArrow,
        terminal: track.outgoingTerminal,
      });
    }
  }
}

/**
 * 重置当前压缩图元上的 incoming edge 累积结果。
 * 多轮相邻几何同步都会重建这些入射关系，因此这里统一清空，避免重复边污染后续 incoming lane 推导。
 */
function resetCompressedLogGraphIncomingGeometry(cells: GitGraphCell[]): void {
  for (const cell of cells) {
    cell.incomingEdges = [];
    for (const track of cell.tracks || [])
      track.incomingEdges = [];
  }
}

/**
 * 当同一条长边在上一行与当前行保持同列，而下一行已确定要向左收一列时，
 * 若当前行左侧目标列为空，则允许当前行提前完成这一步左收。
 * 这样可对齐 IDEA 里“连续长边在真正空出来的那一行就开始折”的形态，
 * 避免把折角拖迟一行后表现成你截图里 `9d7d9d3d` 一带的直线。
 */
function advanceCompressedLogGraphLongTrackCorners(cells: GitGraphCell[]): void {
  for (let index = 1; index < cells.length - 1; index += 1) {
    const previousCell = cells[index - 1];
    const currentCell = cells[index];
    const nextCell = cells[index + 1];
    if (!previousCell || !currentCell || !nextCell) continue;

    const previousTrackByKey = new Map<string, GitGraphTrack>();
    for (const previousTrack of previousCell.tracks || []) {
      const key = buildLogGraphTrackEdgeKey(String(previousTrack.hash || ""), String(previousTrack.sourceHash || ""));
      if (!key || previousTrackByKey.has(key)) continue;
      previousTrackByKey.set(key, previousTrack);
    }

    const nextTrackByKey = new Map<string, GitGraphTrack>();
    for (const nextTrack of nextCell.tracks || []) {
      const key = buildLogGraphTrackEdgeKey(String(nextTrack.hash || ""), String(nextTrack.sourceHash || ""));
      if (!key || nextTrackByKey.has(key)) continue;
      nextTrackByKey.set(key, nextTrack);
    }

    for (const currentTrack of currentCell.tracks || []) {
      const targetHash = String(currentTrack.hash || "").trim();
      const sourceHash = String(currentTrack.sourceHash || "").trim();
      const edgeKey = buildLogGraphTrackEdgeKey(targetHash, sourceHash);
      const previousTrack = previousTrackByKey.get(edgeKey);
      const nextTrack = nextTrackByKey.get(edgeKey);
      const nextTargetIsNode = String(nextCell.commitHash || "").trim() === targetHash;
      const nextLane = nextTrack?.lane ?? (nextTargetIsNode ? nextCell.lane : null);
      if (!previousTrack || nextLane == null) continue;

      const sourceRow = Number(currentTrack.sourceRow ?? 0);
      const targetRow = Number(currentTrack.targetRow ?? sourceRow);
      const isLongTrack = Number.isFinite(sourceRow) && Number.isFinite(targetRow) && targetRow - sourceRow >= 3;
      if (!isLongTrack) continue;
      if (previousTrack.lane !== currentTrack.lane) continue;
      if (nextLane >= currentTrack.lane) continue;
      if (Math.abs(nextLane - currentTrack.lane) !== 1) continue;
      if ((currentTrack.incomingFromLanes || []).length !== 1 || currentTrack.incomingFromLanes?.[0] !== previousTrack.lane) continue;
      if (
        nextTrack
        && ((nextTrack.incomingFromLanes || []).length !== 1 || nextTrack.incomingFromLanes?.[0] !== currentTrack.lane)
      )
        continue;
      if (
        !nextTrack
        && !(nextCell.incomingEdges || []).some((edge) =>
          String(edge.targetHash || "").trim() === targetHash
          && String(edge.sourceHash || "").trim() === sourceHash
          && Number(edge.fromLane) === currentTrack.lane,
        )
      )
        continue;

      const blockedByNode = Number(currentCell.lane) === nextLane;
      if (blockedByNode) continue;
      const blockedByTrack = (currentCell.tracks || []).some((track) =>
        track !== currentTrack
        && Number(track.lane) === nextLane,
      );
      if (blockedByTrack) continue;

      currentTrack.lane = nextLane;
      const incomingFromLanes = normalizeLogGraphIncomingLanes([previousTrack.lane], currentTrack.lane);
      currentTrack.incomingFromLanes = incomingFromLanes;
      currentTrack.incomingFromLane = resolvePrimaryLogGraphIncomingLane(incomingFromLanes, currentTrack.lane) ?? currentTrack.lane;
    }
  }
}

/**
 * 稳定“同一目标提交”的兄弟长边左右顺序。
 * 这里不再依赖上一行的临时压缩列位，而是统一按来源的稳定顺序重排，
 * 避免局部压缩把同一目标的多条长边中途洗牌，形成截图里的 X 形折返。
 */
function stabilizeCompressedLogGraphSiblingTrackOrder(cells: GitGraphCell[]): void {
  for (const cell of cells) {
    if (!cell) continue;
    const groups = groupCompressedLogGraphTracksByTarget(cell.tracks || []);
    for (const currentGroup of groups.values()) {
      if (currentGroup.length < 2) continue;
      stabilizeCompressedLogGraphTrackGroup(currentGroup);
      compactCompressedLogGraphTrackGroupLeft(currentGroup, cell);
    }
  }
}

/**
 * 按目标提交把 track 分组，供兄弟长边顺序稳定化复用。
 */
function groupCompressedLogGraphTracksByTarget(tracks: GitGraphTrack[]): Map<string, GitGraphTrack[]> {
  const grouped = new Map<string, GitGraphTrack[]>();
  for (const track of tracks) {
    const targetHash = String(track.hash || "").trim();
    if (!targetHash) continue;
    const list = grouped.get(targetHash) || [];
    list.push(track);
    grouped.set(targetHash, list);
  }
  return grouped;
}

/**
 * 把当前行同目标 track 的列位，按来源的稳定顺序重新映射。
 * 这里只重排当前组已占用的列集合，不引入新列。
 */
function stabilizeCompressedLogGraphTrackGroup(currentGroup: GitGraphTrack[]): void {
  const currentLanes = [...new Set(currentGroup.map((track) => track.lane))].sort((left, right) => left - right);
  currentGroup
    .sort((left, right) => compareCompressedLogGraphTrackStableOrder(left, right))
    .forEach((track, orderIndex) => {
      const nextLane = currentLanes[orderIndex];
      if (!Number.isFinite(nextLane)) return;
      track.lane = nextLane;
    });
}

/**
 * 若同目标兄弟长边左侧存在空槽，则允许整组向左紧贴当前行其他图元。
 * 这里只整体平移已排好顺序的兄弟组，不改变组内顺序，也不在即将左拐接入目标节点时继续内收，避免再次制造换位。
 */
function compactCompressedLogGraphTrackGroupLeft(currentGroup: GitGraphTrack[], cell: GitGraphCell): void {
  if (currentGroup.some((track) => Number.isFinite(track.outgoingToLane) && Number(track.outgoingToLane) < track.lane))
    return;
  while (true) {
    const minLane = Math.min(...currentGroup.map((track) => track.lane));
    if (!Number.isFinite(minLane) || minLane <= 0)
      return;
    const targetMinLane = minLane - 1;
    if (Number(cell.lane) === targetMinLane)
      return;
    const blocked = (cell.tracks || []).some((track) =>
      !currentGroup.includes(track)
      && Number(track.lane) === targetMinLane,
    );
    if (blocked)
      return;
    currentGroup.forEach((track) => {
      track.lane -= 1;
    });
  }
}

/**
 * 压缩当前行时，先按当前行位置图里的局部顺序处理 track。
 * 这样长边会先占住 IDEA 对齐后的可见位置，再基于上一行做最小让位，
 * 避免仅因原始数组顺序不同而在当前行中途换位。
 */
function compareCompressedLogGraphTrackProcessingOrder(
  left: GitGraphTrack,
  right: GitGraphTrack,
  currentMap: GitGraphPositionMap | undefined,
): number {
  const leftKey = buildLogGraphTrackEdgeKey(String(left.hash || ""), String(left.sourceHash || ""));
  const rightKey = buildLogGraphTrackEdgeKey(String(right.hash || ""), String(right.sourceHash || ""));
  const leftPosition = currentMap?.trackPositionsByEdgeKey.get(leftKey);
  const rightPosition = currentMap?.trackPositionsByEdgeKey.get(rightKey);
  if (leftPosition != null && rightPosition != null && leftPosition !== rightPosition)
    return leftPosition - rightPosition;
  if (leftPosition != null && rightPosition == null)
    return -1;
  if (leftPosition == null && rightPosition != null)
    return 1;
  const stableOrder = compareCompressedLogGraphTrackStableOrder(left, right);
  if (stableOrder !== 0)
    return stableOrder;
  const leftSourceRow = Number(left.sourceRow ?? 0);
  const rightSourceRow = Number(right.sourceRow ?? 0);
  if (leftSourceRow !== rightSourceRow)
    return leftSourceRow - rightSourceRow;
  return String(left.hash || "").localeCompare(String(right.hash || ""));
}

/**
 * 比较同一目标 track 的稳定来源顺序。
 * 优先使用来源节点的稳定列位 `sourceLane`，再用来源提交哈希兜底，尽量贴近 IDEA 的稳定布局排序。
 */
function compareCompressedLogGraphTrackStableOrder(left: GitGraphTrack, right: GitGraphTrack): number {
  const leftSourceLaneValue = left.sourceLane;
  const rightSourceLaneValue = right.sourceLane;
  const leftSourceLane = typeof leftSourceLaneValue === "number" && Number.isFinite(leftSourceLaneValue)
    ? leftSourceLaneValue
    : Number.MAX_SAFE_INTEGER;
  const rightSourceLane = typeof rightSourceLaneValue === "number" && Number.isFinite(rightSourceLaneValue)
    ? rightSourceLaneValue
    : Number.MAX_SAFE_INTEGER;
  if (leftSourceLane !== rightSourceLane) return leftSourceLane - rightSourceLane;
  return String(left.sourceHash || "").localeCompare(String(right.sourceHash || ""));
}

/**
 * 把同一目标节点/track 的真实入射半段追加到集合中，并按来源列去重。
 * 渲染层需要依赖这里保留下来的逐条入射颜色与来源列，避免把不同 branch 的半段错误染成节点自身颜色。
 */
function appendLogGraphIncomingEdges(
  existing: GitGraphIncomingEdge[] | undefined,
  incoming: GitGraphIncomingEdge,
): GitGraphIncomingEdge[] {
  const normalized = [...(existing || [])];
  const duplicateIndex = normalized.findIndex((item) =>
    item.fromLane === incoming.fromLane
    && item.color === incoming.color
    && item.style === incoming.style
    && String(item.sourceHash || "") === String(incoming.sourceHash || "")
    && String(item.targetHash || "") === String(incoming.targetHash || ""),
  );
  if (duplicateIndex >= 0) {
    normalized[duplicateIndex] = incoming;
    return normalized;
  }
  normalized.push(incoming);
  return normalized;
}

/**
 * 优先使用真实 `incomingEdges.fromLane` 重建入射列；若尚无逐条边信息，则回退到既有的 `incomingFromLanes`。
 */
function resolveLogGraphIncomingLanesFromEdges(
  incomingEdges: GitGraphIncomingEdge[] | undefined,
  incomingFromLanes: number[] | undefined,
  incomingFromLane: number | null | undefined,
): number[] {
  const normalize = (source: number[]): number[] => {
    const normalized: number[] = [];
    for (const lane of source) {
      if (!Number.isFinite(lane) || normalized.includes(lane)) continue;
      normalized.push(lane);
    }
    return normalized;
  };
  const lanesFromEdges = normalize((incomingEdges || []).map((edge) => Number(edge.fromLane)));
  const lanesFromField = normalize(Array.isArray(incomingFromLanes) ? incomingFromLanes : []);
  if (lanesFromEdges.length > 0) {
    const sameSet = lanesFromEdges.length === lanesFromField.length
      && lanesFromEdges.every((lane) => lanesFromField.includes(lane));
    if (sameSet && lanesFromField.length > 0)
      return lanesFromField;
    return lanesFromEdges;
  }
  if (lanesFromField.length > 0)
    return lanesFromField;
  const singleLaneSource = Number.isFinite(incomingFromLane) ? [Number(incomingFromLane)] : [];
  const normalized: number[] = [];
  for (const lane of singleLaneSource) {
    if (!Number.isFinite(lane) || normalized.includes(lane)) continue;
    normalized.push(lane);
  }
  return normalized;
}

/**
 * 解析多行 track 在当前行的精确列位。
 * 对齐 IDEA 后，这里优先保留当前行已计算出的 edge 位置，仅在目标列已被占用时才做最小让位。
 */
function resolveCompressedLogGraphTrackCurrentLane(
  track: GitGraphTrack,
  mappedLane: number,
  nodeMappedLane: number,
  previousCell: GitGraphCell | undefined,
  previousMap: GitGraphPositionMap | undefined,
  nextCell: GitGraphCell | undefined,
  occupiedLanes: ReadonlySet<number>,
): number {
  const sourceRow = Number(track.sourceRow ?? 0);
  const targetRow = Number(track.targetRow ?? sourceRow);
  if (!Number.isFinite(sourceRow) || !Number.isFinite(targetRow))
    return mappedLane;
  const isMultiRowTrack = targetRow - sourceRow > 1;
  const isLongTrack = targetRow - sourceRow > 4;
  if (!isMultiRowTrack || !previousMap)
    return mappedLane;
  const sourceHash = String(track.sourceHash || "").trim();
  let referenceFromSourceNode = false;
  let referenceLane = previousMap.trackPositionsByEdgeKey.get(
    buildLogGraphTrackEdgeKey(String(track.hash || ""), sourceHash),
  );
  if (
    referenceLane == null
    && sourceHash
    && String(previousCell?.commitHash || "").trim() === sourceHash
  ) {
    if (!isLongTrack && mappedLane > nodeMappedLane && occupiedLanes.has(mappedLane))
      return resolveCompressedLogGraphTrackFreeLane(mappedLane + 1, mappedLane + 1, occupiedLanes);
    referenceLane = isLongTrack
      ? previousMap.nodePosition
      : Math.max(0, mappedLane - 1);
    referenceFromSourceNode = true;
  }
  if (
    referenceLane != null
    && isLongTrack
    && Number.isFinite(track.sourceLane)
    && referenceLane > Number(track.sourceLane)
  )
    referenceLane = Number(track.sourceLane);
  if (
    referenceLane != null
    && referenceFromSourceNode
    && isLongTrack
    && mappedLane < referenceLane
  )
    referenceLane = mappedLane;
  if (
    referenceLane != null
    && isLongTrack
    && mappedLane < referenceLane
    && referenceLane - mappedLane === 1
  )
    return resolveCompressedLogGraphTrackFreeLane(mappedLane, referenceLane, occupiedLanes);
  if (
    referenceLane == null
    && isLongTrack
    && track.incomingTerminal
    && Number.isFinite(track.sourceLane)
    && Math.abs(Number(track.sourceLane) - mappedLane) > 2
    && String(nextCell?.commitHash || "").trim() === String(track.hash || "").trim()
  )
    referenceLane = mappedLane;
  if (referenceLane == null && isLongTrack && Number.isFinite(track.sourceLane))
    referenceLane = Number(track.sourceLane);
  if (referenceLane == null)
    return mappedLane;
  if (mappedLane !== referenceLane)
    return resolveCompressedLogGraphTrackFreeLane(referenceLane, mappedLane, occupiedLanes);
  return mappedLane;
}

/**
 * 为长边在当前行选择“最靠左且不冲突”的可见列。
 * 若上一可见行的同一条长边所在列在当前行仍然空闲，则继续复用该列；
 * 只有当该列已被当前节点或更靠左的其他可见 track 占用时，才向右挪到第一个空列，
 * 避免被远端隐藏目标的稳定 lane 无意义地再推出一列，生成截图里的假分支和尖角。
 */
function resolveCompressedLogGraphTrackFreeLane(
  preferredLane: number,
  fallbackLane: number,
  occupiedLanes: ReadonlySet<number>,
): number {
  const preferred = Math.max(0, Number(preferredLane));
  const fallback = Math.max(0, Number(fallbackLane));
  const direction = fallback >= preferred ? 1 : -1;
  for (let lane = preferred; direction > 0 ? lane <= fallback : lane >= fallback; lane += direction) {
    if (!occupiedLanes.has(lane))
      return lane;
  }
  let expandedLane = Math.max(preferred, fallback) + 1;
  while (occupiedLanes.has(expandedLane))
    expandedLane += 1;
  return expandedLane;
}

/**
 * 计算当前节点在上一可见行里的所有对接位置。
 * 若上一行里存在指向当前提交的 track，则优先复用这些 track 的局部位置；这样能对齐 IDEA 的 `positionInOtherRow`。
 */
function resolveCompressedLogGraphNodeIncomingLanes(
  hash: string,
  incomingFromLanes: number[],
  previousCell: GitGraphCell | undefined,
  previousMap: GitGraphPositionMap | undefined,
  fallbackLane: number,
): number[] {
  const normalizedHash = String(hash || "").trim();
  if (!previousCell || !previousMap) return [];
  const positions: number[] = [];
  const reservedPositions = normalizedHash ? previousMap.reservedEdgePositionsByTargetHash.get(normalizedHash) || [] : [];
  for (const position of reservedPositions) {
    if (positions.includes(position)) continue;
    positions.push(position);
  }
  if (
    positions.length <= 0
    && normalizedHash
    && (
      String(previousCell.commitHash || "").trim() === normalizedHash
      || previousCell.edges.some((edge) => String(edge.targetHash || "").trim() === normalizedHash)
    )
  )
    positions.push(previousMap.nodePosition);
  for (const position of (normalizedHash ? previousMap.trackPositionsByTargetHash.get(normalizedHash) : []) || []) {
    if (positions.includes(position)) continue;
    positions.push(position);
  }
  if (positions.length > 0) return positions;
  return resolveCompressedLogGraphLaneFallbackPositions(incomingFromLanes, previousMap, fallbackLane);
}

/**
 * 当上一可见行为当前节点保留了 outgoing reserved-edge 位置时，优先把节点对齐到该停靠列。
 * 这样可以保住 IDEA 里“分支先竖直延续，再在真正需要的行发生弯折”的拓扑形态。
 * 若上一行并未给当前节点保留 reserved-edge 停靠位，则当入射列与当前行排序列冲突时，优先采用当前行排序列。
 * 这样可以避免把“应在当前行发生的弯折”错误拖到下一行。
 */
function resolveCompressedLogGraphNodeLane(
  hash: string,
  previousMap: GitGraphPositionMap | undefined,
  fallbackLane: number,
  incomingFromLanes: number[],
): number {
  const normalizedHash = String(hash || "").trim();
  const hasReservedIncomingPosition = normalizedHash
    ? ((previousMap?.reservedEdgePositionsByTargetHash.get(normalizedHash) || []).length > 0)
    : false;
  if (hasReservedIncomingPosition && incomingFromLanes.length === 1) {
    const incomingLane = incomingFromLanes[0]!;
    return incomingLane;
  }
  return fallbackLane;
}

/**
 * 按稳定 lane 回退查找相邻可见行里的局部位置。
 * 当中间存在隐藏提交、无法靠 hash 直接命中上一/下一可见行图元时，仍可沿稳定 lane 延续连线。
 */
function resolveCompressedLogGraphLaneFallbackPositions(
  lanes: number[],
  positionMap: GitGraphPositionMap | undefined,
  fallbackLane: number,
): number[] {
  if (!positionMap || !Array.isArray(lanes) || lanes.length <= 0) return [];
  const resolved: number[] = [];
  for (const lane of lanes) {
    for (const position of positionMap.positionsByLane.get(lane) || []) {
      if (resolved.includes(position)) continue;
      resolved.push(position);
    }
  }
  if (resolved.length > 0) return resolved;
  return Number.isFinite(fallbackLane) ? [fallbackLane] : [];
}

/**
 * 计算当前 track 在上一可见行里的对接位置。
 * - 刚从源节点出发时，对接上一行节点位置；
 * - 中段连续穿行时，对接上一行同一条 edge 的位置。
 */
function resolveCompressedLogGraphTrackIncomingLanes(
  track: GitGraphTrack,
  currentCell: GitGraphCell,
  previousCell: GitGraphCell | undefined,
  previousMap: GitGraphPositionMap | undefined,
  fallbackLane: number,
): number[] {
  if (!previousCell || !previousMap) return [];
  const positions: number[] = [];
  const sourceHash = String(track.sourceHash || "").trim();
  const targetHash = String(track.hash || "").trim();
  const sourceRow = Number(track.sourceRow ?? 0);
  const targetRow = Number(track.targetRow ?? sourceRow);
  const continuousTrackPosition = previousMap.trackPositionsByEdgeKey.get(
    buildLogGraphTrackEdgeKey(String(track.hash || ""), sourceHash),
  );
  const hasSiblingTrackWithSameTarget = (currentCell.tracks || []).some((otherTrack) =>
    otherTrack !== track
    && String(otherTrack.hash || "").trim() === targetHash
    && String(otherTrack.sourceHash || "").trim() !== sourceHash,
  );
  if (continuousTrackPosition != null) {
    const preferredContinuousPosition = hasSiblingTrackWithSameTarget && continuousTrackPosition > fallbackLane
      ? fallbackLane
      : continuousTrackPosition;
    if (!positions.includes(preferredContinuousPosition))
      positions.push(preferredContinuousPosition);
  }
  const hasVerticalSourceEdge = positions.length <= 0
    && sourceHash
    && targetHash
    && Number(track.targetRow ?? 0) - Number(track.sourceRow ?? 0) > 4
    && String(previousCell.commitHash || "").trim() === sourceHash
    && previousCell.edges.some((edge) =>
      String(edge.sourceHash || "").trim() === sourceHash
      && String(edge.targetHash || "").trim() === targetHash
      && Number(edge.sourceLane) === Number(edge.targetLane),
    );
  if (hasVerticalSourceEdge && Number.isFinite(fallbackLane) && !positions.includes(fallbackLane))
    positions.push(fallbackLane);
  if (positions.length <= 0 && sourceHash && String(previousCell.commitHash || "").trim() === sourceHash)
    positions.push(previousMap.nodePosition);
  if (positions.length > 0) return positions;
  return resolveCompressedLogGraphLaneFallbackPositions(track.incomingFromLanes || [], previousMap, fallbackLane);
}

/**
 * 把背景 track 的下半段映射到下一可见行位置。
 * 若下一行仍存在同一条 track，则复用它在下一行的局部列位；若下一行已经到达目标节点，则直接对接该节点；
 * 否则回退到 track 的稳定 lane，保证本行下半段折线可以在当前行内闭合。
 */
function resolveCompressedLogGraphTrackOutgoingLane(
  track: GitGraphTrack,
  nextCell: GitGraphCell | undefined,
  nextMap: GitGraphPositionMap | undefined,
  fallbackLane: number,
): number {
  if (track.outgoingTerminal) return fallbackLane;
  let candidateLane = fallbackLane;
  const targetHash = String(track.hash || "").trim();
  const sourceHash = String(track.sourceHash || "").trim();
  const hasSiblingTrackWithSameTargetInNextCell = (nextCell?.tracks || []).some((otherTrack) =>
    String(otherTrack.hash || "").trim() === targetHash
    && String(otherTrack.sourceHash || "").trim() !== sourceHash,
  );
  if (targetHash && nextCell && nextMap) {
    const matchingTrackPosition = nextMap.trackPositionsByEdgeKey.get(
      buildLogGraphTrackEdgeKey(targetHash, sourceHash),
    );
    if (matchingTrackPosition != null)
      candidateLane = matchingTrackPosition;
    else if (String(nextCell.commitHash || "").trim() === targetHash)
      candidateLane = nextMap.nodePosition;
    else {
      const targetPositions = nextMap.trackPositionsByTargetHash.get(targetHash) || [];
      if (targetPositions.length > 0)
        candidateLane = targetPositions[0]!;
    }
  }
  if (candidateLane === fallbackLane) {
    candidateLane = resolveCompressedLogGraphLaneFallbackPositions([track.targetLane ?? track.lane], nextMap, fallbackLane)[0] ?? fallbackLane;
  }
  if (hasSiblingTrackWithSameTargetInNextCell && candidateLane < fallbackLane)
    candidateLane = fallbackLane;
  return resolveCompressedLogGraphLongTrackStepLane(track, fallbackLane, candidateLane);
}

/**
 * 按长边平滑规则对单步列位进行限幅，避免一行内出现跨越多列的折返尖角。
 */
function resolveCompressedLogGraphLongTrackStepLane(track: GitGraphTrack, fromLane: number, toLane: number): number {
  const sourceRow = Number(track.sourceRow ?? 0);
  const targetRow = Number(track.targetRow ?? sourceRow);
  if (!Number.isFinite(sourceRow) || !Number.isFinite(targetRow))
    return toLane;
  const isLongTrack = targetRow - sourceRow > 4;
  if (!isLongTrack || Math.abs(toLane - fromLane) <= 1)
    return toLane;
  return fromLane + Math.sign(toLane - fromLane);
}

/**
 * 为向下连线选择“下一行位置”。
 * - 若下一可见行里已经把同一目标提交渲染成过路线，则优先对接那条过路线；
 * - 若下一行正好就是目标节点，则直接对接目标节点；
 * - 其余情况回退到原始 lane 映射，保持旧数据兼容。
 */
function resolveCompressedLogGraphEdgeTo(
  edge: GitGraphEdge,
  sourceHash: string,
  nextCell: GitGraphCell | undefined,
  nextMap: GitGraphPositionMap | undefined,
  fallbackLane: number,
): number {
  if (edge.terminal) return fallbackLane;
  const targetHash = String(edge.targetHash || "").trim();
  const sourceRow = Number(edge.sourceRow ?? 0);
  const targetRow = Number(edge.targetRow ?? sourceRow);
  if (targetHash && nextCell && nextMap) {
    const matchingTrackPosition = nextMap.trackPositionsByEdgeKey.get(
      buildLogGraphTrackEdgeKey(targetHash, sourceHash),
    );
    if (matchingTrackPosition != null)
      return matchingTrackPosition;
    if (String(nextCell.commitHash || "").trim() === targetHash)
      return nextMap.nodePosition;
    const targetPositions = nextMap.trackPositionsByTargetHash.get(targetHash) || [];
    if (targetPositions.length > 0)
      return targetPositions[0]!;
  }
  return resolveCompressedLogGraphLaneFallbackPositions([edge.to], nextMap, fallbackLane)[0] ?? fallbackLane;
}

/**
 * 计算下一可见行里“除当前同一条 edge 外”的最右可见位置。
 * 当当前行的 edge 已经占据一个比这些元素都更靠右的独立列时，下一行首个可见续段应继续复用该列，
 * 而不是再被自身的原始排序位置推到更右侧，避免生成无来源的额外尖角。
 */
function resolveCompressedLogGraphMaxOtherPosition(
  nextMap: GitGraphPositionMap,
  excludedTrackPosition: number,
): number {
  let maxPosition = nextMap.nodePosition;
  for (const position of nextMap.trackPositionsByEdgeKey.values()) {
    if (position === excludedTrackPosition) continue;
    if (position > maxPosition)
      maxPosition = position;
  }
  return maxPosition;
}

/**
 * 按输入行序列构建稳定 lane 布局，参考上游 `GraphLayoutBuilder` 的“先排序 head，再沿 down 节点 DFS 分配 layoutIndex”语义。
 */
function buildVisibleGraphLayout(items: GitLogItem[]): VisibleGraphLayout {
  const topology = buildVisibleGraphTopology(items);
  const layoutIndexByRow = assignVisibleGraphLayoutIndices(items, topology);
  return normalizeVisibleGraphLayout(topology, layoutIndexByRow);
}

/**
 * 把当前可见提交投影成轻量 visible graph；只保留可见节点之间的父子关系，为后续稳定布局计算提供 down/up 邻接表。
 */
function buildVisibleGraphTopology(items: GitLogItem[]): VisibleGraphTopology {
  const hashByRow = items.map((item) => String(item.hash || "").trim());
  const visibleRows: number[] = [];
  const downRows = items.map((): number[] => []);
  const upRows = items.map((): number[] => []);
  const hashToRow = new Map<string, number>();

  for (let row = 0; row < hashByRow.length; row += 1) {
    const hash = hashByRow[row];
    if (!hash) continue;
    visibleRows.push(row);
    hashToRow.set(hash, row);
  }

  for (const row of visibleRows) {
    const seenParents = new Set<number>();
    let encounteredMissingEarlierParent = false;
    const parents = Array.isArray(items[row]?.parents) ? items[row]!.parents : [];
    for (const parentRaw of parents) {
      const parentHash = String(parentRaw || "").trim();
      if (!parentHash) continue;
      const parentRow = hashToRow.get(parentHash);
      if (parentRow == null || parentRow <= row) {
        encounteredMissingEarlierParent = true;
        continue;
      }
      if (encounteredMissingEarlierParent || seenParents.has(parentRow)) continue;
      seenParents.add(parentRow);
      downRows[row]!.push(parentRow);
      upRows[parentRow]!.push(row);
    }
  }

  return {
    hashByRow,
    visibleRows,
    downRows,
    upRows,
  };
}

/**
 * 对可见图执行稳定 `layoutIndex` 分配；head 顺序优先对齐 IDEA 的 Git 分支布局比较器，再回退到可见行顺序保持稳定。
 */
function assignVisibleGraphLayoutIndices(items: GitLogItem[], topology: VisibleGraphTopology): number[] {
  const layoutIndexByRow = Array(topology.hashByRow.length).fill(0);
  let currentLayoutIndex = 1;
  const heads = sortVisibleGraphHeadRows(items, topology, resolveVisibleGraphLayoutStartRows(items, topology));

  for (const head of heads) {
    if (layoutIndexByRow[head] !== 0) continue;
    currentLayoutIndex = walkVisibleGraphLayout(topology.downRows, layoutIndexByRow, head, currentLayoutIndex);
  }

  for (const row of topology.visibleRows) {
    if (layoutIndexByRow[row] !== 0) continue;
    currentLayoutIndex = walkVisibleGraphLayout(topology.downRows, layoutIndexByRow, row, currentLayoutIndex);
  }

  return layoutIndexByRow;
}

/**
 * 收集参与稳定 layout 遍历的起点集合。
 * 对齐 IDEA `GraphLayoutBuilder.build(graph, branches, comparator)`：
 * - 既包含真正没有上游边的 graph heads；
 * - 也包含所有带 branch ref 的节点，避免仅按图头遍历时把重要分支压回主干。
 */
function resolveVisibleGraphLayoutStartRows(items: GitLogItem[], topology: VisibleGraphTopology): number[] {
  const startRows = new Set<number>();
  for (const row of topology.visibleRows) {
    if (topology.upRows[row]!.length === 0 || hasVisibleGraphBranchLayoutRef(items[row]))
      startRows.add(row);
  }
  return [...startRows];
}

/**
 * 按接近 IDEA `HeadCommitsComparator` 的规则为布局起点排序。
 * 真正的 graph head 才按 branch ref 比较；非 head 的 branch 起点仍参与遍历，但排序时回退到行号。
 */
function sortVisibleGraphHeadRows(items: GitLogItem[], topology: VisibleGraphTopology, headRows: number[]): number[] {
  return [...headRows].sort((left, right) => compareVisibleGraphHeadRows(items, topology, left, right));
}

/**
 * 比较两个布局起点的优先级。
 * - 若两边都是真正的 graph head，则按代表 ref 的优先级与名称比较；
 * - 只要其中一边拿不到 `refForHeadCommit`，就按 IDEA 语义回退，使其排在真实 head 之后；
 * - 双方都拿不到 ref 时回退到行号，保持排序稳定。
 */
function compareVisibleGraphHeadRows(items: GitLogItem[], topology: VisibleGraphTopology, leftRow: number, rightRow: number): number {
  const leftToken = resolveVisibleGraphStartRowHeadRefToken(items, topology, leftRow);
  const rightToken = resolveVisibleGraphStartRowHeadRefToken(items, topology, rightRow);
  if (leftToken && rightToken) {
    if (leftToken.rank !== rightToken.rank) return leftToken.rank - rightToken.rank;
    const nameOrder = compareLogGraphRefNames(leftToken.name, rightToken.name);
    if (nameOrder !== 0) return nameOrder;
  } else if (leftToken) {
    return -1;
  } else if (rightToken) {
    return 1;
  }
  return leftRow - rightRow;
}

/**
 * 解析某个布局起点在 IDEA `HeadCommitsComparator` 语义下的排序引用。
 * 只有真正没有上游边的 graph head 才能拿到 `refForHeadCommit`；非 head branch 起点统一回退为 `null`。
 */
function resolveVisibleGraphStartRowHeadRefToken(
  items: GitLogItem[],
  topology: VisibleGraphTopology,
  row: number,
): GitLogGraphHeadRefToken | null {
  if ((topology.upRows[row] || []).length > 0) return null;
  const candidates = extractLogGraphHeadRefTokens(String(items[row]?.decorations || ""));
  if (candidates.length <= 0) return null;
  const sorted = [...candidates].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return compareLogGraphRefNames(left.name, right.name);
  });
  return sorted[0] || null;
}

/**
 * 判断某行是否带有会参与 IDEA branch layout 排序的分支引用。
 * 这里只保留本地/远端 branch 类 ref；`tag`、`HEAD` 本身不作为 `branchesCommitId` 起点。
 */
function hasVisibleGraphBranchLayoutRef(item?: GitLogItem | null): boolean {
  return extractLogGraphHeadRefTokens(String(item?.decorations || "")).some((token) => token.rank <= 3);
}

/**
 * 为单个 head 选择参与布局排序的代表引用，语义上对齐 IDEA 的“同一 head 取 branchLayoutComparator 最小 ref”。
 */
function resolveLogGraphHeadRefToken(item?: GitLogItem | null): GitLogGraphHeadRefToken {
  const candidates = extractLogGraphHeadRefTokens(String(item?.decorations || ""));
  if (candidates.length <= 0) return { rank: 99, name: String(item?.hash || "") };
  const sorted = [...candidates].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return compareLogGraphRefNames(left.name, right.name);
  });
  return sorted[0] || { rank: 99, name: String(item?.hash || "") };
}

/**
 * 按 IDEA `RefsModel.getRefForHeadCommit + branchLayoutComparator` 的语义，
 * 从 decorations 中挑出当前提交的最佳 ref 原始名字，供颜色种子直接复用。
 */
function resolveLogGraphBestRefName(decorationsRaw: string): string {
  const candidates = extractLogGraphRawRefCandidates(decorationsRaw);
  if (candidates.length <= 0) return "";
  const sorted = [...candidates].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return compareLogGraphRefNames(left.name, right.name);
  });
  return sorted[0]?.rawName || "";
}

/**
 * 按接近 IDEA `GitReference.REFS_NAMES_COMPARATOR` 的自然排序比较引用名。
 * 这里保留现有的 `numeric` 自然排序，但先补一层“ASCII 领先字符优先”。
 * 否则中文分支名在部分宿主环境里会被排到 `cf-wt/...` 这类 ASCII 工作分支之前，
 * 进而把整条支线错误挤到左侧泳道。
 */
function compareLogGraphRefNames(leftName: string, rightName: string): number {
  const leftAsciiRank = resolveLogGraphRefNameAsciiRank(String(leftName || ""));
  const rightAsciiRank = resolveLogGraphRefNameAsciiRank(String(rightName || ""));
  if (leftAsciiRank !== rightAsciiRank) return leftAsciiRank - rightAsciiRank;
  return String(leftName || "").localeCompare(String(rightName || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * 提取 ref 名第一个可见字符的 ASCII 优先级。
 * 领先字符是 ASCII 时返回更小值，让 `cf-wt/...`、`feature/...` 等工作分支稳定排在中文分支名前面。
 */
function resolveLogGraphRefNameAsciiRank(refName: string): number {
  const normalized = String(refName || "").trim();
  if (!normalized) return 2;
  const firstChar = normalized[0] || "";
  return firstChar.charCodeAt(0) <= 0x7f ? 0 : 1;
}

/**
 * 把单行 decorations 展开成可参与 head 排序的候选引用；`HEAD -> branch` 会同时生成本地分支与 HEAD 两类候选。
 */
function extractLogGraphHeadRefTokens(decorationsRaw: string): GitLogGraphHeadRefToken[] {
  return extractLogGraphRawRefCandidates(decorationsRaw).map((candidate) => ({
    rank: candidate.rank,
    name: candidate.name,
  }));
}

/**
 * 把 decorations 展开成同时保留“排序语义”和“原始名字”的 ref 候选。
 * 排序仍走归一化后的名字，颜色种子则复用原始名字，避免大小写与 decoration 语法破坏 IDEA 的颜色归属。
 */
function extractLogGraphRawRefCandidates(decorationsRaw: string): GitLogGraphRawRefCandidate[] {
  const tokens: GitLogGraphRawRefCandidate[] = [];
  const rows = String(decorationsRaw || "")
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  for (const row of rows) {
    if (row === "HEAD") {
      tokens.push({ rank: 5, name: "head", rawName: "HEAD" });
      continue;
    }
    if (row.startsWith("HEAD ->")) {
      const localName = row.slice("HEAD ->".length).trim();
      if (localName) tokens.push(resolveLogGraphNamedRefToken(localName));
      tokens.push({ rank: 5, name: "head", rawName: "HEAD" });
      continue;
    }
    if (row.startsWith("tag:")) {
      const tagName = row.slice("tag:".length).trim();
      if (tagName) tokens.push({ rank: 4, name: tagName.toLowerCase(), rawName: tagName });
      continue;
    }
    tokens.push(resolveLogGraphNamedRefToken(row));
  }
  return tokens;
}

/**
 * 把普通引用名映射到接近 IDEA Git 分支布局比较器的优先级，优先级越小越靠左。
 */
function resolveLogGraphNamedRefToken(refNameRaw: string): GitLogGraphRawRefCandidate {
  const refName = String(refNameRaw || "").trim();
  const normalized = refName.toLowerCase();
  if (!refName) return { rank: 99, name: "", rawName: "" };
  if (normalized === "origin/master" || normalized === "origin/main") return { rank: 0, name: normalized, rawName: refName };
  if (isLogGraphRemoteRef(normalized)) return { rank: 1, name: normalized, rawName: refName };
  if (normalized === "master" || normalized === "main") return { rank: 2, name: normalized, rawName: refName };
  return { rank: 3, name: normalized, rawName: refName };
}

/**
 * 按远端名提示判断引用是否更像远端分支；这里优先兼容 `origin/*`、`upstream/*` 等 IDEA 常见场景，避免把主干远端误排到本地分支之后。
 */
function isLogGraphRemoteRef(refName: string): boolean {
  const prefix = refName.split("/")[0] || "";
  return LOG_GRAPH_REMOTE_NAME_HINTS.includes(prefix);
}

/**
 * 按 IDEA `walk + first child without layoutIndex` 规则遍历可见图，确保公共祖先不会被后续分支改写到新的 lane。
 */
function walkVisibleGraphLayout(
  downRows: number[][],
  layoutIndexByRow: number[],
  startRow: number,
  initialLayoutIndex: number,
): number {
  const stack: number[] = [startRow];
  let currentLayoutIndex = initialLayoutIndex;

  while (stack.length > 0) {
    const currentRow = stack[stack.length - 1]!;
    const firstVisit = layoutIndexByRow[currentRow] === 0;
    if (firstVisit) layoutIndexByRow[currentRow] = currentLayoutIndex;

    const nextRow = downRows[currentRow]!.find((row) => layoutIndexByRow[row] === 0);
    if (nextRow == null) {
      if (firstVisit) currentLayoutIndex += 1;
      stack.pop();
      continue;
    }

    stack.push(nextRow);
  }

  return currentLayoutIndex;
}

/**
 * 把离散 `layoutIndex` 压缩成前端 lane 下标，后续所有节点/边都统一消费这份稳定映射。
 */
function normalizeVisibleGraphLayout(topology: VisibleGraphTopology, layoutIndexByRow: number[]): VisibleGraphLayout {
  const orderedLayoutIndices = Array.from(new Set(
    topology.visibleRows
      .map((row) => layoutIndexByRow[row])
      .filter((layoutIndex) => layoutIndex > 0),
  )).sort((left, right) => left - right);
  const laneByLayoutIndex = new Map<number, number>();
  orderedLayoutIndices.forEach((layoutIndex, lane) => {
    laneByLayoutIndex.set(layoutIndex, lane);
  });

  const laneByHash = new Map<string, number>();
  const layoutIndexByHash = new Map<string, number>();
  let maxLane = 0;
  for (const row of topology.visibleRows) {
    const hash = topology.hashByRow[row];
    if (!hash) continue;
    const isolated = topology.downRows[row]!.length === 0 && topology.upRows[row]!.length === 0;
    const lane = isolated ? 0 : (laneByLayoutIndex.get(layoutIndexByRow[row]) ?? 0);
    laneByHash.set(hash, lane);
    layoutIndexByHash.set(hash, layoutIndexByRow[row] ?? 0);
    if (lane > maxLane) maxLane = lane;
  }

  return {
    laneByHash,
    layoutIndexByHash,
    maxLane,
  };
}

/**
 * 提取提交自身直接携带的颜色种子。
 * 对齐 IDEA `GraphColorManagerImpl`，head fragment 的颜色 ID 直接来自“最佳 ref 原始名字”的哈希，
 * 这里不再附加 `local:` / `ref:` 之类的前缀，避免同名分支仅因 decoration 语法不同而取到不同颜色。
 * 另外，主干远端 `origin/master|main` / `upstream/master|main` 会归一到本地等价名字，
 * 避免远端前缀把主干颜色推到与旁侧远端支线过于接近的碰撞色。
 */
function resolveLogGraphDirectColorSeed(item?: GitLogItem | null): string {
  return normalizeLogGraphDirectColorSeed(resolveLogGraphBestRefName(String(item?.decorations || "")));
}

/**
 * 归一化直接 ref 的颜色种子。
 * - 普通 ref 继续保留原始名字，对齐 IDEA 以 ref 名决定颜色 ID 的语义；
 * - 仅对主干远端分支做“远端名 -> 本地主干名”的收敛，让 `origin/master` 与 `master`
 *   保持同色，同时避免它与其它 `origin/*` 远端支线更容易撞到同一颜色。
 */
function normalizeLogGraphDirectColorSeed(seed: string): string {
  const normalized = String(seed || "").trim();
  if (!normalized) return "";
  const lowered = normalized.toLowerCase();
  if (lowered === "origin/master" || lowered === "upstream/master") return "master";
  if (lowered === "origin/main" || lowered === "upstream/main") return "main";
  return normalized;
}

/**
 * 按 IDEA `GraphColorManagerImpl + GraphColorGetterByHead` 的语义生成 fragment 颜色种子。
 * - 头 fragment 使用 head ref 名字；
 * - 其余 fragment 主要由 fragment lane 决定；
 * - 若上下文还不足，则回退到调用方传入的稳定种子。
 */
function resolveLogGraphFragmentColorSeed(
  headSeed: string,
  headLane: number | null,
  lane: number,
  fallbackSeed: string,
): string {
  if (headSeed && headLane === lane) return headSeed;
  if (Number.isFinite(lane) && lane >= 0) return `fragment:${lane}`;
  return fallbackSeed;
}

/**
 * 兼容旧调用方，优先取直接引用种子，缺失时再回退到调用方传入的稳定种子。
 */
function resolveLogGraphColorSeed(item: GitLogItem, fallbackSeed: string): string {
  return resolveLogGraphDirectColorSeed(item) || fallbackSeed;
}

/**
 * 从所有可见来源里选出当前共享段应继承的支配 head。
 * 优先选择布局更靠左的 head；若相同，则优先较新的来源，尽量贴近 IDEA “更重要 branch 支配共享子图颜色”的语义。
 */
function resolveLogGraphDominantSourceHead(
  sources: GitGraphActiveSource[],
): { headSeed: string; headLane: number | null } {
  let dominantSource: GitGraphActiveSource | null = null;
  for (const source of sources) {
    const headSeed = String(source.headSeed || "").trim();
    if (!headSeed) continue;
    if (!dominantSource) {
      dominantSource = source;
      continue;
    }
    const dominantHeadLane = Number.isFinite(dominantSource.headLane) ? Number(dominantSource.headLane) : Number.MAX_SAFE_INTEGER;
    const currentHeadLane = Number.isFinite(source.headLane) ? Number(source.headLane) : Number.MAX_SAFE_INTEGER;
    if (currentHeadLane < dominantHeadLane) {
      dominantSource = source;
      continue;
    }
    if (currentHeadLane > dominantHeadLane) continue;
    if (source.sourceRow > dominantSource.sourceRow) {
      dominantSource = source;
      continue;
    }
    if (source.sourceRow === dominantSource.sourceRow && source.lane < dominantSource.lane)
      dominantSource = source;
  }
  return {
    headSeed: String(dominantSource?.headSeed || ""),
    headLane: Number.isFinite(dominantSource?.headLane) ? Number(dominantSource?.headLane) : null,
  };
}

/**
 * 按当前活跃 lane 的 head fragment 语义，为过路线计算颜色种子。
 */
function resolveLogGraphActiveLaneColorSeed(entry: ActiveGraphLane, lane: number): string {
  return resolveLogGraphFragmentColorSeed(entry.headSeed, entry.headLane, entry.layoutIndex, entry.colorSeed);
}

/**
 * 从活跃 lane 中提取当前行真正需要显示的过路线。
 * - 对齐 IDEA `PrintElementGeneratorImpl`，超过阈值的长边只显示两端可见段，中间隐藏；
 * - 截断点通过 track 的 `incoming/outgoing + terminal + arrow` 状态传给渲染层，避免把整条长边一直画到屏幕下方。
 */
function buildLogGraphTracks(
  active: Array<ActiveGraphLane | null>,
  supplemental: ReadonlyMap<string, ActiveGraphLane>,
  currentLane: number,
  currentHash: string,
  currentRow: number,
): GitGraphTrack[] {
  const tracks: GitGraphTrack[] = [];
  for (let lane = 0; lane < active.length; lane += 1) {
    const entry = active[lane];
    if (!entry) continue;
      const visibleSources = resolveVisibleLogGraphSources(entry.sources, entry.targetRow, lane, currentRow);
      if (visibleSources.length <= 0) continue;
    const fallbackColorSeed = resolveLogGraphActiveLaneColorSeed(entry, lane);
    for (const visibleSource of visibleSources) {
      const incomingFromLanes = normalizeLogGraphIncomingLanes([visibleSource.lane], lane);
      const trackLane = resolveLogGraphTrackLane(entry, lane, visibleSource, currentLane, currentHash);
      if (trackLane == null) continue;
      tracks.push({
        lane: trackLane,
        incomingFromLane: resolvePrimaryLogGraphIncomingLane(incomingFromLanes, trackLane) ?? trackLane,
        incomingFromLanes,
        color: resolveLogGraphColor(String(visibleSource.colorSeed || "").trim() || fallbackColorSeed),
        style: "solid",
        hash: entry.hash,
        sourceHash: visibleSource.hash,
        sourceRow: visibleSource.sourceRow,
        targetRow: entry.targetRow,
        sourceLane: visibleSource.lane,
        targetLane: lane,
        incomingTerminal: shouldRenderLogGraphIncomingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
        incomingArrow: shouldRenderLogGraphIncomingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
        outgoingTerminal: shouldRenderLogGraphOutgoingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
        outgoingArrow: shouldRenderLogGraphOutgoingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
      });
    }
  }
  for (const entry of Array.from(supplemental.values()).sort((left, right) => left.stableLane - right.stableLane || left.targetRow - right.targetRow)) {
    if (findLogGraphLaneByHash(active, entry.hash) >= 0) continue;
    const visibleSources = resolveVisibleLogGraphSources(entry.sources, entry.targetRow, entry.stableLane, currentRow);
    if (visibleSources.length <= 0) continue;
    const fallbackColorSeed = resolveLogGraphActiveLaneColorSeed(entry, entry.stableLane);
    for (const visibleSource of visibleSources) {
      const incomingFromLanes = normalizeLogGraphIncomingLanes([visibleSource.lane], entry.stableLane);
      const trackLane = resolveLogGraphTrackLane(entry, entry.stableLane, visibleSource, currentLane, currentHash);
      if (trackLane == null) continue;
      tracks.push({
        lane: trackLane,
        incomingFromLane: resolvePrimaryLogGraphIncomingLane(incomingFromLanes, trackLane) ?? trackLane,
        incomingFromLanes,
        color: resolveLogGraphColor(String(visibleSource.colorSeed || "").trim() || fallbackColorSeed),
        style: "solid",
        hash: entry.hash,
        sourceHash: visibleSource.hash,
        sourceRow: visibleSource.sourceRow,
        targetRow: entry.targetRow,
        sourceLane: visibleSource.lane,
        targetLane: entry.stableLane,
        incomingTerminal: shouldRenderLogGraphIncomingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
        incomingArrow: shouldRenderLogGraphIncomingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
        outgoingTerminal: shouldRenderLogGraphOutgoingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
        outgoingArrow: shouldRenderLogGraphOutgoingArrow(visibleSource.sourceRow, entry.targetRow, currentRow),
      });
    }
  }
  return tracks;
}

/**
 * 为过路线选择当前行的显示位置。
 * - 对齐 IDEA `GraphElementComparatorByLayoutIndex` 的核心规则：边在排序时优先锚定到“两端更靠右的 layout index”；
 * - 因此回并到左侧主干时，中间几行的过路线要继续停留在右侧列，直到真正接入目标节点那一行再斜向落回主干；
 * - IDEA 的 `PrintElement` 允许边和节点处于同一列，边会在节点下方绘制，因此这里不再把冲突边强行右移到新列。
 */
function resolveLogGraphTrackLane(
  entry: ActiveGraphLane,
  stableLane: number,
  visibleSource: GitGraphActiveSource,
  currentLane: number,
  currentHash: string,
): number | null {
  if (entry.hash === currentHash) return null;
  const rightmostSourceLane = Math.max(stableLane, visibleSource.lane);
  if (rightmostSourceLane !== currentLane) return rightmostSourceLane;
  return rightmostSourceLane;
}

/**
 * 计算当前单元涉及的最大 lane，下游用它统一估算图谱列宽。
 */
function computeLogGraphMaxLane(
  lane: number,
  tracks: GitGraphTrack[],
  edges: GitGraphEdge[],
): number {
  return resolveLogGraphVisibleMaxLane({
    lane,
    color: "transparent",
    tracks,
    edges,
    incomingFromLane: null,
    incomingFromLanes: [],
    nodeKind: "default",
    maxLane: lane,
  });
}

/**
 * 为当前提交选择供父边继承的来源信息。
 * - 可见行会把当前行记为新的边起点；
 * - 隐藏行继续沿用已有来源，保持压缩后的 visible graph 仍能正确对接。
 */
function resolveLogGraphParentSources(
  currentEntry: ActiveGraphLane | null,
  lane: number,
  rowIndex: number,
  visible: boolean,
  sourceHash: string,
  headSeed: string,
  headLane: number | null,
  colorSeed: string,
): GitGraphActiveSource[] {
  if (visible) return [{ lane, sourceRow: rowIndex, hash: sourceHash, preserveLane: true, headSeed, headLane, colorSeed }];
  return normalizeLogGraphActiveSources(
    (currentEntry?.sources || []).map((source) => (
      source.preserveLane
        ? source
        : { ...source, lane, sourceRow: rowIndex }
    )),
    lane,
    rowIndex,
    sourceHash,
  );
}

/**
 * 把指定提交放到目标 lane，并记录它在当前 visible graph 中对应的来源边信息。
 */
function placeLogGraphCommit(
  active: Array<ActiveGraphLane | null>,
  supplemental: Map<string, ActiveGraphLane>,
  commitHash: string,
  lane: number,
  layoutIndex: number,
  colorSeed: string,
  headSeed: string,
  headLane: number | null,
  sources: GitGraphActiveSource[],
  targetRow: number,
): void {
  const previousEntryAtLane = active[lane];
  if (previousEntryAtLane && previousEntryAtLane.hash !== commitHash && shouldPreserveLogGraphEntry(previousEntryAtLane)) {
    supplemental.set(previousEntryAtLane.hash, resolveLogGraphActiveEntry(
      supplemental.get(previousEntryAtLane.hash) || null,
      previousEntryAtLane,
      previousEntryAtLane.stableLane,
      previousEntryAtLane.hash,
    )!);
  }
  /**
   * 同一个父提交可能仍暂存在其他 active lane。
   * 若直接覆盖目标 lane 而不先并回这些来源，旧可见 child 会在当前行之后整条消失。
   */
  let carriedSources: GitGraphActiveSource[] = [];
  for (let index = 0; index < active.length; index += 1) {
    if (index === lane) continue;
    const duplicateEntry = active[index];
    if (!duplicateEntry || duplicateEntry.hash !== commitHash) continue;
    carriedSources = carriedSources.concat(duplicateEntry.sources);
  }
  let previousEntry = resolveLogGraphActiveEntry(
    previousEntryAtLane?.hash === commitHash ? previousEntryAtLane : null,
    supplemental.get(commitHash) || null,
    lane,
    commitHash,
  );
  supplemental.delete(commitHash);
  for (let index = 0; index < active.length; index += 1) {
    if (index === lane) continue;
    if (active[index]?.hash === commitHash) active[index] = null;
  }
  const normalizedSources = normalizeLogGraphActiveSources(
    [
      ...(previousEntry?.sources || []),
      ...carriedSources,
      ...sources,
    ],
    sources[0]?.lane ?? lane,
    targetRow,
    sources[0]?.hash || commitHash,
  );
  const dominantSourceHead = resolveLogGraphDominantSourceHead(normalizedSources);
  previousEntry = previousEntry || null;
  active[lane] = {
    hash: commitHash,
    stableLane: lane,
    layoutIndex,
    colorSeed: previousEntry?.colorSeed || colorSeed,
    headSeed: dominantSourceHead.headSeed || headSeed || previousEntry?.headSeed || "",
    headLane: dominantSourceHead.headSeed
      ? dominantSourceHead.headLane
      : (headSeed ? headLane : (previousEntry?.headLane ?? null)),
    sources: normalizedSources,
    targetRow,
  };
}

/**
 * 合并当前主活跃槽与补充长边槽位的同 hash 状态，避免真实可见来源被中途覆盖后彻底丢失。
 */
function resolveLogGraphActiveEntry(
  primary: ActiveGraphLane | null,
  secondary: ActiveGraphLane | null,
  fallbackLane: number,
  fallbackHash: string,
): ActiveGraphLane | null {
  if (!primary && !secondary) return null;
  const merged = [primary, secondary].filter(Boolean) as ActiveGraphLane[];
  const base = merged[0]!;
  const mergedSources = normalizeLogGraphActiveSources(
    merged.flatMap((entry) => entry.sources),
    fallbackLane,
    merged[0]?.targetRow ?? 0,
    fallbackHash,
  );
  const dominantSourceHead = resolveLogGraphDominantSourceHead(mergedSources);
  return {
    hash: fallbackHash,
    stableLane: primary?.stableLane ?? secondary?.stableLane ?? fallbackLane,
    layoutIndex: primary?.layoutIndex ?? secondary?.layoutIndex ?? fallbackLane,
    colorSeed: primary?.colorSeed || secondary?.colorSeed || base.colorSeed,
    headSeed: dominantSourceHead.headSeed || primary?.headSeed || secondary?.headSeed || base.headSeed,
    headLane: dominantSourceHead.headSeed
      ? dominantSourceHead.headLane
      : (primary?.headLane ?? secondary?.headLane ?? base.headLane),
    sources: mergedSources,
    targetRow: Math.max(...merged.map((entry) => entry.targetRow)),
  };
}

/**
 * 只把真实从可见行发出的长边挪到补充槽位，隐藏链路仍沿原 active 行为收敛，避免额外占列。
 */
function shouldPreserveLogGraphEntry(entry: ActiveGraphLane): boolean {
  return entry.sources.some((source) => Boolean(source.preserveLane));
}

/**
 * 若当前节点本身就会把该目标提交重新放回 active，且被挤掉的长边只有一个可见来源，则无需额外保留补充槽位。
 * 这样可以继续沿用原有“后出现的同目标可见分支会收敛到同一入射列”的语义，避免把旧来源再额外右推一列。
 */
function shouldPreserveDisplacedLogGraphEntry(entry: ActiveGraphLane, parents: string[]): boolean {
  if (!shouldPreserveLogGraphEntry(entry)) return false;
  const normalizedParents = new Set(parents.map((parent) => String(parent || "").trim()).filter(Boolean));
  if (!normalizedParents.has(entry.hash)) return true;
  return entry.sources.filter((source) => Boolean(source.preserveLane)).length > 1;
}

/**
 * 克隆当前活跃 lane。
 * - 遇到可见行时，隐藏来源继续收敛到当前稳定列；
 * - 已锚定到可见行的来源保留原始列，确保被覆盖后仍能按真实拓扑回到目标节点。
 */
function cloneLogGraphActiveLanes(active: Array<ActiveGraphLane | null>, preserveIncomingFromLanes = false): Array<ActiveGraphLane | null> {
  return active.map((entry, index) => (
    entry
      ? {
          ...entry,
          stableLane: index,
          sources: preserveIncomingFromLanes
            ? normalizeLogGraphActiveSources(entry.sources, index, entry.targetRow, entry.sources[0]?.hash || entry.hash)
            : normalizeLogGraphActiveSources(entry.sources.map((source) => (
              source.preserveLane ? source : { ...source, lane: index }
            )), index, entry.targetRow, entry.sources[0]?.hash || entry.hash),
        }
      : null
  ));
}

/**
 * 查找指定提交当前是否已经占据某条活跃 lane；共享祖先若已落位，则后续分支必须复用该稳定 lane。
 */
function findLogGraphLaneByHash(active: Array<ActiveGraphLane | null>, commitHash: string): number {
  return active.findIndex((entry) => entry?.hash === commitHash);
}

/**
 * 筛出当前行应当保留的来源集合。
 * 长边中段直接省略，只在靠近两端的可见部分保留 track，并在截断点交给渲染层绘制箭头。
 */
function resolveVisibleLogGraphSources(
  sources: GitGraphActiveSource[],
  targetRow: number,
  fallbackLane: number,
  currentRow: number,
): GitGraphActiveSource[] {
  const normalizedSources = normalizeLogGraphActiveSources(sources, fallbackLane, currentRow, "");
  return normalizedSources.filter((source) => isLogGraphEdgeVisibleInRow(source.sourceRow, targetRow, currentRow));
}

/**
 * 判断一条边是否属于需要折叠中段的长边。
 */
function isLogGraphLongEdge(sourceRow: number, targetRow: number): boolean {
  return targetRow - sourceRow >= LOG_GRAPH_LONG_EDGE_SIZE;
}

/**
 * 判断指定行是否应该显示这条边。
 * 语义对齐 IDEA `isEdgeVisibleInRow`：短边全程可见，长边只显示靠近两端的 `visiblePartSize` 行。
 */
function isLogGraphEdgeVisibleInRow(sourceRow: number, targetRow: number, currentRow: number): boolean {
  if (currentRow <= sourceRow || currentRow >= targetRow) return false;
  if (!isLogGraphLongEdge(sourceRow, targetRow)) return true;
  const attachmentDistance = Math.min(currentRow - sourceRow, targetRow - currentRow);
  return attachmentDistance <= LOG_GRAPH_VISIBLE_PART_SIZE;
}

/**
 * 判断当前行是否需要在 track 上半段绘制向上的终止箭头。
 */
function shouldRenderLogGraphIncomingArrow(sourceRow: number, targetRow: number, currentRow: number): boolean {
  return isLogGraphLongEdge(sourceRow, targetRow) && targetRow - currentRow === LOG_GRAPH_VISIBLE_PART_SIZE;
}

/**
 * 判断当前行是否需要在 track 下半段绘制向下的终止箭头。
 */
function shouldRenderLogGraphOutgoingArrow(sourceRow: number, targetRow: number, currentRow: number): boolean {
  return isLogGraphLongEdge(sourceRow, targetRow) && currentRow - sourceRow === LOG_GRAPH_VISIBLE_PART_SIZE;
}

/**
 * 归一化活跃边来源集合。
 * 同一 lane 若出现多次，保留最近一次来源行，这样共享同列轨迹时不会因为更早的来源把当前可见段错误隐藏掉。
 */
function normalizeLogGraphActiveSources(
  sources: GitGraphActiveSource[],
  fallbackLane: number,
  fallbackSourceRow: number,
  fallbackHash: string,
): GitGraphActiveSource[] {
  const source = Array.isArray(sources) && sources.length > 0
    ? sources
    : [{ lane: fallbackLane, sourceRow: fallbackSourceRow, hash: fallbackHash }];
  const normalized: GitGraphActiveSource[] = [];
  for (const item of source) {
    const lane = Number(item?.lane);
    const sourceRow = Number(item?.sourceRow);
    const hash = String(item?.hash || "");
    const preserveLane = Boolean(item?.preserveLane);
    const headSeed = String(item?.headSeed || "");
    const headLane = Number.isFinite(item?.headLane) ? Number(item?.headLane) : null;
    const colorSeed = String(item?.colorSeed || "");
    if (!Number.isFinite(lane) || !Number.isFinite(sourceRow)) continue;
    const existingIndex = normalized.findIndex((entry) => Number(entry.lane) === lane);
    if (existingIndex >= 0) {
      const existing = normalized[existingIndex]!;
      if (sourceRow > existing.sourceRow || (sourceRow === existing.sourceRow && preserveLane && !existing.preserveLane))
        normalized[existingIndex] = { lane, sourceRow, hash, preserveLane, headSeed, headLane, colorSeed };
      continue;
    }
    normalized.push({ lane, sourceRow, hash, preserveLane, headSeed, headLane, colorSeed });
  }
  return normalized;
}

/**
 * 归一化一组入射 lane，保留插入顺序并去重，供节点和 track 统一渲染多条上半段连线。
 */
function normalizeLogGraphIncomingLanes(incomingFromLanes: number[], fallbackLane: number): number[] {
  const source = Array.isArray(incomingFromLanes) && incomingFromLanes.length > 0
    ? incomingFromLanes
    : [fallbackLane];
  const normalized: number[] = [];
  for (const lane of source) {
    if (!Number.isFinite(lane) || normalized.includes(lane)) continue;
    normalized.push(lane);
  }
  return normalized;
}

/**
 * 为仍兼容单值字段的场景挑选主入射 lane；若存在侧向接入，优先返回侧向 lane，以保留 merge 对接的视觉重点。
 */
function resolvePrimaryLogGraphIncomingLane(incomingFromLanes: number[], currentLane: number): number | null {
  for (const lane of incomingFromLanes) {
    if (lane !== currentLane) return lane;
  }
  return incomingFromLanes[0] ?? null;
}

/**
 * 移除尾部空 lane，避免图谱宽度随着历史浏览持续膨胀。
 */
function trimTrailingLogGraphLanes(active: Array<ActiveGraphLane | null>): void {
  while (active.length > 0 && active[active.length - 1] === null) active.pop();
}

/**
 * 识别当前提交是否带有 HEAD 标记，用于区分普通节点与当前分支头节点。
 */
function hasHeadDecoration(decorationsRaw: string): boolean {
  const rows = String(decorationsRaw || "")
    .split(",")
    .map((entry) => String(entry || "").trim());
  return rows.some((entry) => entry === "HEAD" || entry.startsWith("HEAD ->"));
}

/**
 * 生成稳定的字符串哈希，保证同一颜色种子在不同 lane 上仍保持相同配色。
 */
function hashLogGraphSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}
