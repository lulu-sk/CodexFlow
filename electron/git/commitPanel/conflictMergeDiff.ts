// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitConflictMergeTokenRange } from "./conflictMergeShared";
export { buildConflictMergeLineRanges } from "./conflictMergeLineDiff";

export type ConflictMergePairRange = {
  start1: number;
  end1: number;
  start2: number;
  end2: number;
};

export type ConflictMergeRange = {
  oursStart: number;
  oursEnd: number;
  baseStart: number;
  baseEnd: number;
  theirsStart: number;
  theirsEnd: number;
};

type ConflictMergeDiffOperation = {
  type: "equal" | "delete" | "insert";
};

type ConflictMergeEqualRangeBuilder<T> = {
  length1: number;
  length2: number;
  objects1: T[];
  objects2: T[];
  isEqual: (left: T, right: T) => boolean;
  equalRanges: ConflictMergePairRange[];
  index1: number;
  index2: number;
};

type ConflictMergeFairDiff = {
  length1: number;
  length2: number;
  equalRanges: ConflictMergePairRange[];
};

const CONFLICT_MERGE_DIFF_MATRIX_CELL_LIMIT = 4_000_000;

/**
 * 在规模可控时使用动态规划构造稳定的最短编辑脚本。
 */
function buildConflictMergeDynamicDiffOperations<T>(
  left: T[],
  right: T[],
  isEqual: (left: T, right: T) => boolean,
): ConflictMergeDiffOperation[] {
  const leftLength = left.length;
  const rightLength = right.length;
  const table = Array.from({ length: leftLength + 1 }, () => new Uint32Array(rightLength + 1));

  for (let leftIndex = 1; leftIndex <= leftLength; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightLength; rightIndex += 1) {
      table[leftIndex][rightIndex] = isEqual(left[leftIndex - 1]!, right[rightIndex - 1]!)
        ? table[leftIndex - 1][rightIndex - 1]! + 1
        : Math.max(table[leftIndex - 1]![rightIndex]!, table[leftIndex]![rightIndex - 1]!);
    }
  }

  const operations: ConflictMergeDiffOperation[] = [];
  let leftIndex = leftLength;
  let rightIndex = rightLength;
  while (leftIndex > 0 && rightIndex > 0) {
    if (isEqual(left[leftIndex - 1]!, right[rightIndex - 1]!)) {
      operations.push({ type: "equal" });
      leftIndex -= 1;
      rightIndex -= 1;
      continue;
    }
    if (table[leftIndex - 1]![rightIndex]! >= table[leftIndex]![rightIndex - 1]!) {
      operations.push({ type: "delete" });
      leftIndex -= 1;
      continue;
    }
    operations.push({ type: "insert" });
    rightIndex -= 1;
  }

  while (leftIndex > 0) {
    operations.push({ type: "delete" });
    leftIndex -= 1;
  }
  while (rightIndex > 0) {
    operations.push({ type: "insert" });
    rightIndex -= 1;
  }

  return operations.reverse();
}

/**
 * 在大输入场景下回退到 Myers 算法，避免 O(n*m) 内存膨胀。
 */
function buildConflictMergeMyersDiffOperations<T>(
  left: T[],
  right: T[],
  isEqual: (left: T, right: T) => boolean,
): ConflictMergeDiffOperation[] {
  const leftLength = left.length;
  const rightLength = right.length;
  const maxDepth = leftLength + rightLength;
  const offset = maxDepth;
  const vector = new Array<number>((maxDepth * 2) + 1).fill(0);
  const trace: number[][] = [];

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const previousVector = vector.slice();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const index = offset + diagonal;
      const goDown = diagonal === -depth
        || (diagonal !== depth && previousVector[index - 1]! < previousVector[index + 1]!);
      let leftIndex = goDown ? previousVector[index + 1]! : previousVector[index - 1]! + 1;
      let rightIndex = leftIndex - diagonal;
      while (leftIndex < leftLength
        && rightIndex < rightLength
        && isEqual(left[leftIndex]!, right[rightIndex]!)) {
        leftIndex += 1;
        rightIndex += 1;
      }
      vector[index] = leftIndex;
      if (leftIndex >= leftLength && rightIndex >= rightLength) {
        trace.push(vector.slice());
        return buildConflictMergeMyersDiffOperationsFromTrace(trace, left, right, isEqual);
      }
    }
    trace.push(vector.slice());
  }

  return [];
}

/**
 * 根据 Myers trace 回放最终编辑脚本。
 */
function buildConflictMergeMyersDiffOperationsFromTrace<T>(
  trace: number[][],
  left: T[],
  right: T[],
  isEqual: (left: T, right: T) => boolean,
): ConflictMergeDiffOperation[] {
  const leftLength = left.length;
  const rightLength = right.length;
  const maxDepth = leftLength + rightLength;
  const offset = maxDepth;
  const operations: ConflictMergeDiffOperation[] = [];
  let leftIndex = leftLength;
  let rightIndex = rightLength;

  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    const vector = trace[depth - 1]!;
    const diagonal = leftIndex - rightIndex;
    const goDown = diagonal === -depth
      || (diagonal !== depth && vector[offset + diagonal - 1]! < vector[offset + diagonal + 1]!);
    const previousDiagonal = goDown ? diagonal + 1 : diagonal - 1;
    const previousLeftIndex = vector[offset + previousDiagonal]!;
    const previousRightIndex = previousLeftIndex - previousDiagonal;

    while (leftIndex > previousLeftIndex && rightIndex > previousRightIndex) {
      operations.push({ type: "equal" });
      leftIndex -= 1;
      rightIndex -= 1;
    }

    if (goDown) {
      operations.push({ type: "insert" });
      rightIndex -= 1;
    } else {
      operations.push({ type: "delete" });
      leftIndex -= 1;
    }
  }

  while (leftIndex > 0 && rightIndex > 0) {
    if (!isEqual(left[leftIndex - 1]!, right[rightIndex - 1]!)) break;
    operations.push({ type: "equal" });
    leftIndex -= 1;
    rightIndex -= 1;
  }
  while (leftIndex > 0) {
    operations.push({ type: "delete" });
    leftIndex -= 1;
  }
  while (rightIndex > 0) {
    operations.push({ type: "insert" });
    rightIndex -= 1;
  }

  return operations.reverse();
}

/**
 * 先裁掉公共前后缀，再选择动态规划或 Myers 路径。
 */
function buildConflictMergeDiffOperations<T>(
  left: T[],
  right: T[],
  isEqual: (left: T, right: T) => boolean,
): ConflictMergeDiffOperation[] {
  let prefixLength = 0;
  while (prefixLength < left.length
    && prefixLength < right.length
    && isEqual(left[prefixLength]!, right[prefixLength]!)) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (suffixLength < left.length - prefixLength
    && suffixLength < right.length - prefixLength
    && isEqual(left[left.length - 1 - suffixLength]!, right[right.length - 1 - suffixLength]!)) {
    suffixLength += 1;
  }

  const middleLeft = left.slice(prefixLength, left.length - suffixLength);
  const middleRight = right.slice(prefixLength, right.length - suffixLength);
  const cellCount = middleLeft.length * middleRight.length;
  const middleOperations = cellCount <= CONFLICT_MERGE_DIFF_MATRIX_CELL_LIMIT
    ? buildConflictMergeDynamicDiffOperations(middleLeft, middleRight, isEqual)
    : buildConflictMergeMyersDiffOperations(middleLeft, middleRight, isEqual);

  return [
    ...Array.from({ length: prefixLength }, () => ({ type: "equal" as const })),
    ...middleOperations,
    ...Array.from({ length: suffixLength }, () => ({ type: "equal" as const })),
  ];
}

/**
 * 创建 equal range builder，用于把 diff 脚本压成 fair equal ranges。
 */
function createConflictMergeEqualRangeBuilder<T>(args: {
  length1: number;
  length2: number;
  objects1: T[];
  objects2: T[];
  isEqual: (left: T, right: T) => boolean;
}): ConflictMergeEqualRangeBuilder<T> {
  return {
    length1: args.length1,
    length2: args.length2,
    objects1: args.objects1,
    objects2: args.objects2,
    isEqual: args.isEqual,
    equalRanges: [],
    index1: 0,
    index2: 0,
  };
}

/**
 * 把相邻 equal range 合并，减少后续 merge builder 的边界噪音。
 */
function pushConflictMergeEqualRange<T>(
  builder: ConflictMergeEqualRangeBuilder<T>,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): void {
  if (start1 === end1 && start2 === end2) return;
  const last = builder.equalRanges[builder.equalRanges.length - 1];
  if (last && last.end1 === start1 && last.end2 === start2) {
    last.end1 = end1;
    last.end2 = end2;
    return;
  }
  builder.equalRanges.push({ start1, end1, start2, end2 });
}

/**
 * 按 diff 操作把等价 run 收口为 fair diff。
 */
function buildConflictMergeFairDiff<T>(
  left: T[],
  right: T[],
  isEqual: (left: T, right: T) => boolean,
): ConflictMergeFairDiff {
  const operations = buildConflictMergeDiffOperations(left, right, isEqual);
  const builder = createConflictMergeEqualRangeBuilder({
    length1: left.length,
    length2: right.length,
    objects1: left,
    objects2: right,
    isEqual,
  });

  let leftIndex = 0;
  let rightIndex = 0;
  let runStart1 = 0;
  let runStart2 = 0;
  let inEqualRun = false;

  /**
   * 把当前累计的 equal run 写回 builder。
   */
  const flushEqualRun = (): void => {
    if (!inEqualRun) return;
    pushConflictMergeEqualRange(builder, runStart1, runStart2, leftIndex, rightIndex);
    builder.index1 = leftIndex;
    builder.index2 = rightIndex;
    inEqualRun = false;
  };

  for (const operation of operations) {
    if (operation.type === "equal") {
      if (!inEqualRun) {
        runStart1 = leftIndex;
        runStart2 = rightIndex;
        inEqualRun = true;
      }
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    flushEqualRun();
    if (operation.type === "delete") leftIndex += 1;
    else rightIndex += 1;
  }
  flushEqualRun();

  return {
    length1: left.length,
    length2: right.length,
    equalRanges: builder.equalRanges,
  };
}

/**
 * 把左右两份 base-target fair diff 合成为最终三方 merge ranges。
 */
export function buildConflictMergeRanges<T>(
  args: {
    baseItems: T[];
    oursItems: T[];
    theirsItems: T[];
    isEqual: (left: T, right: T) => boolean;
  },
): ConflictMergeRange[] {
  const leftDiff = buildConflictMergeFairDiff(args.baseItems, args.oursItems, args.isEqual);
  const rightDiff = buildConflictMergeFairDiff(args.baseItems, args.theirsItems, args.isEqual);
  const leftRanges = leftDiff.equalRanges;
  const rightRanges = rightDiff.equalRanges;

  const ranges: ConflictMergeRange[] = [];
  let oursIndex = 0;
  let baseIndex = 0;
  let theirsIndex = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  /**
   * 把当前公共片段之前尚未消费的区间收口为 merge range。
   */
  const pushChange = (
    startOurs: number,
    startBase: number,
    startTheirs: number,
    endOurs: number,
    endBase: number,
    endTheirs: number,
  ): void => {
    if (startOurs === endOurs && startBase === endBase && startTheirs === endTheirs) return;
    ranges.push({
      oursStart: startOurs,
      oursEnd: endOurs,
      baseStart: startBase,
      baseEnd: endBase,
      theirsStart: startTheirs,
      theirsEnd: endTheirs,
    });
  };

  /**
   * 在识别到三方公共 unchanged 段后，推进三侧游标。
   */
  const markEqual = (
    startOurs: number,
    startBase: number,
    startTheirs: number,
    endOurs: number,
    endBase: number,
    endTheirs: number,
  ): void => {
    pushChange(oursIndex, baseIndex, theirsIndex, startOurs, startBase, startTheirs);
    oursIndex = endOurs;
    baseIndex = endBase;
    theirsIndex = endTheirs;
  };

  /**
   * 对齐一组左右 unchanged range，并返回下一次应推进的侧别。
   */
  const addEqualOverlap = (
    leftRange: ConflictMergePairRange,
    rightRange: ConflictMergePairRange,
  ): "left" | "right" => {
    if (leftRange.end1 <= rightRange.start1) return "left";
    if (rightRange.end1 <= leftRange.start1) return "right";

    const overlapBaseStart = Math.max(leftRange.start1, rightRange.start1);
    const overlapBaseEnd = Math.min(leftRange.end1, rightRange.end1);
    const overlapCount = overlapBaseEnd - overlapBaseStart;
    const overlapLeftShift = overlapBaseStart - leftRange.start1;
    const overlapRightShift = overlapBaseStart - rightRange.start1;
    const overlapOursStart = leftRange.start2 + overlapLeftShift;
    const overlapTheirsStart = rightRange.start2 + overlapRightShift;

    markEqual(
      overlapOursStart,
      overlapBaseStart,
      overlapTheirsStart,
      overlapOursStart + overlapCount,
      overlapBaseEnd,
      overlapTheirsStart + overlapCount,
    );
    return leftRange.end1 <= rightRange.end1 ? "left" : "right";
  };

  while (leftIndex < leftRanges.length && rightIndex < rightRanges.length) {
    const advanceSide = addEqualOverlap(leftRanges[leftIndex]!, rightRanges[rightIndex]!);
    if (advanceSide === "left") leftIndex += 1;
    else rightIndex += 1;
  }

  pushChange(
    oursIndex,
    baseIndex,
    theirsIndex,
    args.oursItems.length,
    args.baseItems.length,
    args.theirsItems.length,
  );
  return ranges;
}

/**
 * 为区间切片结果附加指定偏移量。
 */
export function offsetConflictMergeRange(
  range: ConflictMergeRange,
  offsets: {
    ours: number;
    base: number;
    theirs: number;
  },
): ConflictMergeRange {
  return {
    oursStart: range.oursStart + offsets.ours,
    oursEnd: range.oursEnd + offsets.ours,
    baseStart: range.baseStart + offsets.base,
    baseEnd: range.baseEnd + offsets.base,
    theirsStart: range.theirsStart + offsets.theirs,
    theirsEnd: range.theirsEnd + offsets.theirs,
  };
}

/**
 * 判断某个 token range 是否与目标范围相交。
 */
export function intersectsConflictMergeRange(
  range: GitConflictMergeTokenRange | null,
  start: number,
  end: number,
): boolean {
  if (!range) return false;
  return start < range.end && end > range.start;
}
