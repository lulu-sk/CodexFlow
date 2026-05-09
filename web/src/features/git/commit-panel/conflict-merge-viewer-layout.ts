// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ConflictMergeBlock } from "./conflict-merge-model";

export type ConflictMergeViewerPaneKey = "left" | "result" | "right";

export type ConflictMergeViewerHiddenArea = {
  startLine: number;
  endLine: number;
};

export type ConflictMergeViewerFoldSeparator = {
  side: "left" | "right";
  sourceLine: number;
  targetLine: number;
};

export type ConflictMergeViewerFoldingPlan = {
  hiddenAreas: Record<ConflictMergeViewerPaneKey, ConflictMergeViewerHiddenArea[]>;
  separators: ConflictMergeViewerFoldSeparator[];
};

export type ConflictMergeViewerScrollPair = {
  master: number;
  slave: number;
};

export type ConflictMergeViewerScrollMaps = {
  leftToResult: ConflictMergeViewerScrollPair[];
  resultToLeft: ConflictMergeViewerScrollPair[];
  resultToRight: ConflictMergeViewerScrollPair[];
  rightToResult: ConflictMergeViewerScrollPair[];
};

type ConflictMergeViewerPaneLineRange = {
  start: number;
  end: number;
};

type ConflictMergeViewerFoldBlock = {
  left: ConflictMergeViewerPaneLineRange | null;
  result: ConflictMergeViewerPaneLineRange | null;
  right: ConflictMergeViewerPaneLineRange | null;
};

type ConflictMergeViewerFoldGroup = {
  blocks: ConflictMergeViewerFoldBlock[];
};

type ConflictMergeViewerLineCounts = Record<ConflictMergeViewerPaneKey, number>;

type ConflictMergeViewerChangedLineOffsets = {
  leftStart: number;
  leftEnd: number;
  resultStart: number;
  resultEnd: number;
  rightStart: number;
  rightEnd: number;
};

type ConflictMergeViewerFoldPlanArgs = {
  blocks: ConflictMergeBlock[];
  lineCounts: ConflictMergeViewerLineCounts;
  contextRange: number;
};

/**
 * 按与 merge model 一致的“逻辑行”口径统计文本行数，避免末尾换行把 Monaco 额外空行算进同步映射。
 */
export function countConflictMergeViewerLogicalLines(text: string): number {
  const tokens = String(text || "").match(/[^\n]*\n|[^\n]+$/g) || [];
  return Math.max(1, tokens.length);
}

/**
 * 基于三方块坐标构造左右-结果的同步滚动边界，参考上游 `BaseSyncScrollable` 使用的首尾边界对。
 */
export function buildConflictMergeViewerScrollMaps(args: {
  blocks: ConflictMergeBlock[];
  lineCounts: ConflictMergeViewerLineCounts;
}): ConflictMergeViewerScrollMaps {
  const offsets = buildConflictMergeViewerChangedLineOffsets(args.blocks);
  const leftToResult = buildConflictMergeViewerScrollPairs(
    offsets.map((item) => ({ master: item.leftStart, slave: item.resultStart })),
    offsets.map((item) => ({ master: item.leftEnd, slave: item.resultEnd })),
    args.lineCounts.left,
    args.lineCounts.result,
  );
  const resultToRight = buildConflictMergeViewerScrollPairs(
    offsets.map((item) => ({ master: item.resultStart, slave: item.rightStart })),
    offsets.map((item) => ({ master: item.resultEnd, slave: item.rightEnd })),
    args.lineCounts.result,
    args.lineCounts.right,
  );

  return {
    leftToResult,
    resultToLeft: reverseConflictMergeViewerScrollPairs(leftToResult),
    resultToRight,
    rightToResult: reverseConflictMergeViewerScrollPairs(resultToRight),
  };
}

/**
 * 把某一栏的逻辑行号映射到另一栏，沿用 IDEA `BaseSyncScrollable.transferLine` 的区间插值规则。
 */
export function transferConflictMergeViewerLine(
  line: number,
  pairs: ConflictMergeViewerScrollPair[],
): number {
  if (pairs.length <= 0) return Math.max(0, Math.floor(Number(line) || 0));

  const safeLine = Math.max(0, Math.floor(Number(line) || 0));
  let master1 = pairs[0].master;
  let master2 = pairs[0].master;
  let slave1 = pairs[0].slave;
  let slave2 = pairs[0].slave;

  for (const pair of pairs) {
    master1 = master2;
    slave1 = slave2;
    master2 = pair.master;
    slave2 = pair.slave;
    if (safeLine <= pair.master) break;
  }

  if (master1 === safeLine) return slave1;
  if (master2 === safeLine) return slave2;
  if (master2 < safeLine) return (safeLine - master2) + slave2;
  return Math.min(slave1 + (safeLine - master1), slave2);
}

/**
 * 按 IDEA `FoldingModelSupport` 的 unchanged group 语义，生成三栏同步折叠计划与分隔线锚点。
 */
export function buildConflictMergeViewerFoldingPlan(
  args: ConflictMergeViewerFoldPlanArgs,
): ConflictMergeViewerFoldingPlan {
  const emptyPlan: ConflictMergeViewerFoldingPlan = {
    hiddenAreas: {
      left: [],
      result: [],
      right: [],
    },
    separators: [],
  };
  if (args.contextRange < 0) return emptyPlan;

  const groups = buildConflictMergeViewerFoldGroups(args);
  if (groups.length <= 0) return emptyPlan;

  const visibleBlocks = groups
    .map((group) => group.blocks[0] || null)
    .filter((block): block is ConflictMergeViewerFoldBlock => !!block);

  return {
    hiddenAreas: {
      left: visibleBlocks
        .map((block) => convertConflictMergeViewerHiddenArea(block.left))
        .filter((range): range is ConflictMergeViewerHiddenArea => !!range),
      result: visibleBlocks
        .map((block) => convertConflictMergeViewerHiddenArea(block.result))
        .filter((range): range is ConflictMergeViewerHiddenArea => !!range),
      right: visibleBlocks
        .map((block) => convertConflictMergeViewerHiddenArea(block.right))
        .filter((range): range is ConflictMergeViewerHiddenArea => !!range),
    },
    separators: visibleBlocks.flatMap((block) => {
      const result: ConflictMergeViewerFoldSeparator[] = [];
      if (block.left && block.result) {
        result.push({
          side: "left",
          sourceLine: block.left.start + 1,
          targetLine: block.result.start + 1,
        });
      }
      if (block.result && block.right) {
        result.push({
          side: "right",
          sourceLine: block.result.start + 1,
          targetLine: block.right.start + 1,
        });
      }
      return result;
    }),
  };
}

/**
 * 把块列表转换为稳定排序的三方 changed offsets，供滚动映射与折叠计划复用。
 */
function buildConflictMergeViewerChangedLineOffsets(
  blocks: ConflictMergeBlock[],
): ConflictMergeViewerChangedLineOffsets[] {
  return [...blocks]
    .sort((left, right) => {
      if (left.resultStart !== right.resultStart) return left.resultStart - right.resultStart;
      if (left.baseStart !== right.baseStart) return left.baseStart - right.baseStart;
      return left.index - right.index;
    })
    .map((block) => ({
      leftStart: block.oursStart,
      leftEnd: block.oursEnd,
      resultStart: block.resultStart,
      resultEnd: block.resultEnd,
      rightStart: block.theirsStart,
      rightEnd: block.theirsEnd,
    }));
}

/**
 * 把起始/结束边界交错压成 scroll pair 列表，保持与 IDEA `processHelper` 一样的边界顺序。
 */
function buildConflictMergeViewerScrollPairs(
  starts: ConflictMergeViewerScrollPair[],
  ends: ConflictMergeViewerScrollPair[],
  masterLineCount: number,
  slaveLineCount: number,
): ConflictMergeViewerScrollPair[] {
  const result: ConflictMergeViewerScrollPair[] = [{ master: 0, slave: 0 }];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = ends[index];
    if (start) result.push(start);
    if (end) result.push(end);
  }
  result.push({
    master: Math.max(0, masterLineCount),
    slave: Math.max(0, slaveLineCount),
  });
  return result;
}

/**
 * 为反向滚动同步构造镜像 pair，避免组件层重复手动交换 master/slave。
 */
function reverseConflictMergeViewerScrollPairs(
  pairs: ConflictMergeViewerScrollPair[],
): ConflictMergeViewerScrollPair[] {
  return pairs.map((pair) => ({
    master: pair.slave,
    slave: pair.master,
  }));
}

/**
 * 基于 changed block 边界构造 unchanged fold group，参考上游 `FoldingBuilderBase.addGroup` 的范围裁切规则。
 */
function buildConflictMergeViewerFoldGroups(
  args: ConflictMergeViewerFoldPlanArgs,
): ConflictMergeViewerFoldGroup[] {
  const groups: ConflictMergeViewerFoldGroup[] = [];
  const changedOffsets = buildConflictMergeViewerChangedLineOffsets(args.blocks);
  let lastLeft = Number.MIN_SAFE_INTEGER;
  let lastResult = Number.MIN_SAFE_INTEGER;
  let lastRight = Number.MIN_SAFE_INTEGER;

  for (const offset of changedOffsets) {
    pushConflictMergeViewerFoldGroup({
      starts: {
        left: lastLeft,
        result: lastResult,
        right: lastRight,
      },
      ends: {
        left: offset.leftStart,
        result: offset.resultStart,
        right: offset.rightStart,
      },
      groups,
      lineCounts: args.lineCounts,
      contextRange: args.contextRange,
    });
    lastLeft = offset.leftEnd;
    lastResult = offset.resultEnd;
    lastRight = offset.rightEnd;
  }

  pushConflictMergeViewerFoldGroup({
    starts: {
      left: lastLeft,
      result: lastResult,
      right: lastRight,
    },
    ends: {
      left: Number.MAX_SAFE_INTEGER,
      result: Number.MAX_SAFE_INTEGER,
      right: Number.MAX_SAFE_INTEGER,
    },
    groups,
    lineCounts: args.lineCounts,
    contextRange: args.contextRange,
  });

  return groups;
}

/**
 * 向结果集中追加一个 unchanged group；同一组会生成 4/8/16 三层候选折叠块，首层即当前默认可见块。
 */
function pushConflictMergeViewerFoldGroup(args: {
  starts: Record<ConflictMergeViewerPaneKey, number>;
  ends: Record<ConflictMergeViewerPaneKey, number>;
  groups: ConflictMergeViewerFoldGroup[];
  lineCounts: ConflictMergeViewerLineCounts;
  contextRange: number;
}): void {
  const blocks: ConflictMergeViewerFoldBlock[] = [];
  for (let depth = 0; ; depth += 1) {
    const shift = resolveConflictMergeViewerRangeShift(args.contextRange, depth);
    if (shift < 0) break;

    const block: ConflictMergeViewerFoldBlock = {
      left: createConflictMergeViewerFoldRange(
        args.starts.left + shift,
        args.ends.left - shift,
        args.lineCounts.left,
      ),
      result: createConflictMergeViewerFoldRange(
        args.starts.result + shift,
        args.ends.result - shift,
        args.lineCounts.result,
      ),
      right: createConflictMergeViewerFoldRange(
        args.starts.right + shift,
        args.ends.right - shift,
        args.lineCounts.right,
      ),
    };
    if (block.left || block.result || block.right) {
      blocks.push(block);
    }
  }

  if (blocks.length > 0) {
    args.groups.push({ blocks });
  }
}

/**
 * 创建单栏折叠区间；不足两行的 unchanged 片段不进入折叠计划，和 IDEA 的 `createBlock` 条件一致。
 */
function createConflictMergeViewerFoldRange(
  start: number,
  end: number,
  lineCount: number,
): ConflictMergeViewerPaneLineRange | null {
  const boundedStart = clampConflictMergeViewerLine(start, 0, lineCount);
  const boundedEnd = clampConflictMergeViewerLine(end, 0, lineCount);
  if (boundedEnd - boundedStart < 2) return null;
  return {
    start: boundedStart,
    end: boundedEnd,
  };
}

/**
 * 把 0-based 半开区间转换为 Monaco `setHiddenAreas` 所需的 1-based 闭区间。
 */
function convertConflictMergeViewerHiddenArea(
  range: ConflictMergeViewerPaneLineRange | null,
): ConflictMergeViewerHiddenArea | null {
  if (!range) return null;
  return {
    startLine: range.start + 1,
    endLine: range.end,
  };
}

/**
 * 参考上游 `getRangeShift` 的 4/8/16 三层上下文裁切策略。
 */
function resolveConflictMergeViewerRangeShift(
  contextRange: number,
  depth: number,
): number {
  if (depth === 0) return contextRange;
  if (depth === 1) return contextRange * 2;
  if (depth === 2) return contextRange * 4;
  return -1;
}

/**
 * 对行号做边界收敛，避免首尾虚拟值进入实际折叠或滚动坐标。
 */
function clampConflictMergeViewerLine(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || 0)));
}
